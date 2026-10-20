"""Experimental source-only patch for the audited 26.1013.40934 x64 CUA helper."""
import argparse
import hashlib
import json
from pathlib import Path
import struct

import pefile

EXPECTED = "74fc7fbf8cb9500dc953da053145d4bc64b9675d631cdb15c7c2490b5fa4b759"
CALLBACK_RVA = 0x42489
VTABLE_ENTRY_RVA = 0x12DEC8


def digest(data):
    return hashlib.sha256(data).hexdigest()


def align(value, boundary):
    return (value + boundary - 1) // boundary * boundary


def worker_code(rva, imports):
    code = bytearray()
    labels = {}
    fixups = []

    def emit(hex_bytes):
        code.extend(bytes.fromhex(hex_bytes))

    def relative(prefix, destination):
        emit(prefix)
        fixups.append((len(code), destination))
        code.extend(b"\0" * 4)

    # Windows x64 ABI：0x38 栈空间包含 shadow space、CreateThread 参数和闭包指针。
    labels["wrapper"] = len(code)
    emit("4883ec38 48894c2430 4c8b5108 31c0 b201 f0410fb05211")
    relative("0f85", "success")
    # 一次性标志阻止重复排队；AddRef 使原事件委托在工作线程结束前保持存活。
    emit("488b01 ff5008 31c9 31d2")
    relative("4c8d05", "worker")
    emit("4c8b4c2430 488364242000 488364242800")
    relative("ff15", imports["CreateThread"])
    emit("4885c0")
    relative("0f84", "create_failed")
    emit("4889c1")
    relative("ff15", imports["CloseHandle"])
    labels["success"] = len(code)
    emit("31c0 4883c438 c3")
    labels["create_failed"] = len(code)
    emit("488b4c2430 488b4108 c6401100 488b01 ff5010 b805400080 4883c438 c3")
    labels["wrapper_end"] = len(code)

    labels["worker"] = len(code)
    emit("4883ec38 48894c2428 b901000000")
    relative("ff15", imports["RoInitialize"])
    # RoInitialize 失败时不能运行 COM 截图，也不能错误调用 RoUninitialize。
    emit("85c0")
    relative("0f88", "init_failed")
    emit("488b4c2428")
    relative("e8", CALLBACK_RVA)
    relative("ff15", imports["RoUninitialize"])
    emit("488b4c2428 488b01 ff5010 31c0 4883c438 c3")
    labels["init_failed"] = len(code)
    emit("488b4c2428 488b4108 c6401100 488b01 ff5010 31c0 4883c438 c3")
    labels["worker_end"] = len(code)
    for offset, destination in fixups:
        target = rva + labels[destination] if isinstance(destination, str) else destination
        struct.pack_into("<i", code, offset, target - (rva + offset + 4))
    return code, labels


def prepare(data):
    if digest(data) != EXPECTED:
        raise RuntimeError("Unsupported helper hash; refusing patch")
    pe = pefile.PE(data=data)
    base = pe.OPTIONAL_HEADER.ImageBase
    imports = {item.name.decode(): item.address - base
               for entry in pe.DIRECTORY_ENTRY_IMPORT for item in entry.imports if item.name}
    rva = pe.OPTIONAL_HEADER.SizeOfImage
    code, labels = worker_code(rva, imports)
    out = bytearray(data)
    patches = []

    def replace(at_rva, original, modified, name):
        offset = pe.get_offset_from_rva(at_rva)
        if out[offset:offset + len(original)] != original:
            raise RuntimeError("Unexpected instructions: " + name)
        out[offset:offset + len(original)] = modified
        patches.append({"name": name, "rva": hex(at_rva),
                        "before": original.hex(), "after": modified.hex()})

    # 保留原回调互斥保护；重入时直接正常返回，避免阻塞事件线程。
    replace(0x424BE, bytes.fromhex("0f855b310000"), bytes.fromhex("0f853d310000"), "busy_return")
    # 包装器已经设置一次性标志，工作线程继续执行原回调主体。
    replace(0x424CF, bytes.fromhex("740d"), bytes.fromhex("eb0d"), "worker_once_flag")
    replace(VTABLE_ENTRY_RVA, struct.pack("<Q", base + CALLBACK_RVA),
            struct.pack("<Q", base + rva), "callback_entry")
    if not any(item.rva == VTABLE_ENTRY_RVA for block in pe.DIRECTORY_ENTRY_BASERELOC
               for item in block.entries):
        raise RuntimeError("Missing callback address relocation")

    payload = bytearray(code)
    payload.extend(b"\0" * (align(len(payload), 4) - len(payload)))
    unwind_rva = rva + len(payload)
    # 两个新增函数都只在序言中 sub rsp,0x38，记录对应的 UWOP_ALLOC_SMALL。
    payload.extend(bytes.fromhex("0104010004620000"))
    payload.extend(b"\0" * (align(len(payload), 4) - len(payload)))
    exception_rva = rva + len(payload)
    directory = pe.OPTIONAL_HEADER.DATA_DIRECTORY[3]
    exception_offset = pe.get_offset_from_rva(directory.VirtualAddress)
    original_functions = data[exception_offset:exception_offset + directory.Size]
    payload.extend(original_functions)
    for start, end in [("wrapper", "wrapper_end"), ("worker", "worker_end")]:
        payload.extend(struct.pack("<III", rva + labels[start], rva + labels[end], unwind_rva))
    exception_size = directory.Size + 24

    raw_offset = align(len(out), pe.OPTIONAL_HEADER.FileAlignment)
    raw_size = align(len(payload), pe.OPTIONAL_HEADER.FileAlignment)
    out.extend(b"\0" * (raw_offset - len(out)))
    out.extend(payload)
    out.extend(b"\0" * (raw_size - len(payload)))
    new_header = pe.sections[-1].get_file_offset() + 40
    if new_header + 40 > pe.OPTIONAL_HEADER.SizeOfHeaders or any(out[new_header:new_header + 40]):
        raise RuntimeError("No section header space")
    struct.pack_into("<8sIIIIIIHHI", out, new_header, b".cuafix\0", len(payload), rva,
                     raw_size, raw_offset, 0, 0, 0, 0, 0x60000020)
    struct.pack_into("<H", out, pe.FILE_HEADER.get_field_absolute_offset("NumberOfSections"),
                     pe.FILE_HEADER.NumberOfSections + 1)
    struct.pack_into("<I", out, pe.OPTIONAL_HEADER.get_field_absolute_offset("SizeOfImage"),
                     align(rva + len(payload), pe.OPTIONAL_HEADER.SectionAlignment))
    struct.pack_into("<I", out, pe.OPTIONAL_HEADER.get_field_absolute_offset("SizeOfCode"),
                     pe.OPTIONAL_HEADER.SizeOfCode + raw_size)
    struct.pack_into("<II", out, directory.get_file_offset(), exception_rva, exception_size)
    parsed = pefile.PE(data=bytes(out))
    struct.pack_into("<I", out, parsed.OPTIONAL_HEADER.get_field_absolute_offset("CheckSum"),
                     parsed.generate_checksum())
    parsed = pefile.PE(data=bytes(out))
    if len(parsed.DIRECTORY_ENTRY_EXCEPTION) != len(pe.DIRECTORY_ENTRY_EXCEPTION) + 2:
        raise RuntimeError("Exception table verification failed")
    return bytes(out), {"code_rva": hex(rva), "worker_rva": hex(rva + labels["worker"]),
                        "code_size": len(code), "patches": patches}


def require_stopped():
    import subprocess
    active = subprocess.run(["powershell.exe", "-NoProfile", "-Command", "@(Get-Process -Name ChatGPT,Codex,codex-computer-use,codex-computer-use-swift -ErrorAction SilentlyContinue).Count"], capture_output=True, text=True, check=True, creationflags=0x08000000)
    if active.stdout.strip() != "0":
        raise RuntimeError("Exit Codex and all CUA helpers before install/restore")


def main():
    global TARGET, STAGE, MANIFEST, BACKUP
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "install", "restore"])
    parser.add_argument("target", type=Path, help="Explicit path to the 1013 legacy x64 helper, not the Swift helper")
    arguments = parser.parse_args()
    mode = arguments.mode
    TARGET = arguments.target.resolve()
    suffix = "frame-worker"
    STAGE = TARGET.with_name(TARGET.name + ".lite-" + suffix + ".stage")
    MANIFEST = TARGET.with_name(TARGET.name + ".lite-" + suffix + ".json")
    BACKUP = TARGET.with_name(TARGET.name + ".before-lite-" + suffix)
    if mode != "prepare":
        require_stopped()
    data = TARGET.read_bytes()
    if mode == "prepare":
        modified, details = prepare(data)
        if STAGE.exists() or MANIFEST.exists():
            raise RuntimeError("Prepared files already exist; inspect them before preparing again")
        STAGE.write_bytes(modified)
        manifest = {"target": str(TARGET), "backup": str(BACKUP),
                    "original_sha256": digest(data), "patched_sha256": digest(modified),
                    "original_size": len(data), "patched_size": len(modified), **details}
        MANIFEST.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    else:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        if manifest["original_sha256"] != EXPECTED or Path(manifest["target"]).resolve() != TARGET:
            raise RuntimeError("Manifest does not match this audited 1013 target")
        expected = manifest["original_sha256" if mode == "install" else "patched_sha256"]
        if digest(data) != expected:
            raise RuntimeError("Target hash mismatch")
        modified = (STAGE if mode == "install" else BACKUP).read_bytes()
        wanted = manifest["patched_sha256" if mode == "install" else "original_sha256"]
        if digest(modified) != wanted:
            raise RuntimeError("Replacement hash mismatch")
        if mode == "install":
            if BACKUP.exists():
                raise RuntimeError("Backup exists; refusing overwrite")
            BACKUP.write_bytes(data)
            if digest(BACKUP.read_bytes()) != expected:
                raise RuntimeError("Backup verification failed")
        # 原位替换保留 @oai 和 %40oai 的硬链接关系。
        TARGET.write_bytes(modified)
        if digest(TARGET.read_bytes()) != wanted:
            raise RuntimeError("Installed hash verification failed")
    print(json.dumps({"mode": mode, **manifest}, indent=2))


if __name__ == "__main__":
    main()

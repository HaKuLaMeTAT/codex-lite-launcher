"""Experimental source-only patch for the audited 26.1013.40934 x64 CUA helper."""
import argparse
import hashlib
import json
from pathlib import Path
import struct

import pefile

EXPECTED = "b6b0e4979b89e5c22dab866f0974bc817c0d08cb359e1c2dd7be3dccb9e181eb"
SOURCE_RVA = 0x3E3CB
DEST_RVA = 0x3E4C1
ORIGINAL = bytes.fromhex("4889c1488d15ffd310004c8d44246041ff11")


def digest(data):
    return hashlib.sha256(data).hexdigest()


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
    suffix = "cursor"
    STAGE = TARGET.with_name(TARGET.name + ".lite-" + suffix + ".stage")
    MANIFEST = TARGET.with_name(TARGET.name + ".lite-" + suffix + ".json")
    BACKUP = TARGET.with_name(TARGET.name + ".before-lite-" + suffix)
    if mode != "prepare":
        require_stopped()
    data = TARGET.read_bytes()
    if mode == "prepare":
        if digest(data) != EXPECTED:
            raise RuntimeError("Only audited 26.1013.40934 x64 helper is supported")
        pe = pefile.PE(data=data)
        offset = pe.get_offset_from_rva(SOURCE_RVA)
        if data[offset:offset + len(ORIGINAL)] != ORIGINAL:
            raise RuntimeError("Unexpected original instructions; refusing patch")
        # 保留基础截图会话指针的保存和后续生命周期，只跳过光标接口查询及设置。
        patch = b"\xe9" + struct.pack("<i", DEST_RVA - SOURCE_RVA - 5)
        modified = bytearray(data[:offset] + patch + data[offset + len(patch):])
        parsed = pefile.PE(data=modified)
        struct.pack_into("<I", modified, parsed.OPTIONAL_HEADER.get_field_absolute_offset("CheckSum"), parsed.generate_checksum())
        modified = bytes(modified)
        if STAGE.exists() or MANIFEST.exists():
            raise RuntimeError("Prepared files already exist; inspect them before preparing again")
        STAGE.write_bytes(modified)
        manifest = {"target": str(TARGET), "backup": str(BACKUP),
                    "original_sha256": digest(data), "patched_sha256": digest(modified),
                    "offset": offset, "original_bytes": data[offset:offset + 5].hex(),
                    "patched_bytes": patch.hex(), "size": len(data)}
        MANIFEST.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    else:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        if manifest["original_sha256"] != EXPECTED or Path(manifest["target"]).resolve() != TARGET:
            raise RuntimeError("Manifest does not match this audited 1013 target")
        if mode == "install":
            if digest(data) != manifest["original_sha256"]:
                raise RuntimeError("Target hash mismatch; refusing install")
            modified = STAGE.read_bytes()
            if digest(modified) != manifest["patched_sha256"]:
                raise RuntimeError("Stage hash mismatch; refusing install")
            if BACKUP.exists():
                raise RuntimeError("Backup already exists; refusing overwrite")
            BACKUP.write_bytes(data)
            if digest(BACKUP.read_bytes()) != manifest["original_sha256"]:
                raise RuntimeError("Backup verification failed")
        else:
            if digest(data) != manifest["patched_sha256"]:
                raise RuntimeError("Target hash mismatch; refusing restore")
            modified = BACKUP.read_bytes()
            if digest(modified) != manifest["original_sha256"]:
                raise RuntimeError("Backup hash mismatch; refusing restore")
        # 原位写入以保持 @oai 和 %40oai 两个入口之间已有的硬链接。
        TARGET.write_bytes(modified)
        if digest(TARGET.read_bytes()) != digest(modified):
            raise RuntimeError("Written target verification failed")
    print(json.dumps({"mode": mode, **manifest}, indent=2))


if __name__ == "__main__":
    main()

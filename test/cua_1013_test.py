"""Real PE construction and reversible installation on temporary copies only."""
import contextlib
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import pefile

ROOT = Path(__file__).resolve().parent.parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "standalone" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cursor = load("cua_cursor_1013")
worker = load("cua_frame_worker_1013")


def invoke(module, mode, target):
    # 仅替换运行进程检查，真实读写临时 EXE；不声称验证了正式截图业务。
    with patch.object(sys, "argv", [module.__file__, mode, str(target)]), patch.object(module, "require_stopped", lambda: None), contextlib.redirect_stdout(io.StringIO()):
        module.main()


@unittest.skipUnless(os.environ.get("CODEX_TEST_CUA"), "Set CODEX_TEST_CUA to the unmodified 1013 legacy x64 helper")
class NativePatchTests(unittest.TestCase):
    def test_prepare_install_restore_and_pe_invariants(self):
        original = Path(os.environ["CODEX_TEST_CUA"]).read_bytes()
        self.assertEqual(hashlib.sha256(original).hexdigest(), cursor.EXPECTED)
        with tempfile.TemporaryDirectory(prefix="codex-lite-cua-") as directory:
            target = Path(directory) / "codex-computer-use.exe"
            target.write_bytes(original)
            invoke(cursor, "prepare", target)
            invoke(cursor, "install", target)
            first = target.read_bytes()
            self.assertEqual(hashlib.sha256(first).hexdigest(), worker.EXPECTED)
            pe = pefile.PE(data=first)
            self.assertEqual(pe.generate_checksum(), pe.OPTIONAL_HEADER.CheckSum)
            self.assertEqual(first[pe.get_offset_from_rva(cursor.SOURCE_RVA):][:5], bytes.fromhex("e9f1000000"))
            invoke(worker, "prepare", target)
            candidate = Path(str(target) + ".lite-frame-worker.stage").read_bytes()
            patched = pefile.PE(data=candidate)
            self.assertEqual(patched.generate_checksum(), patched.OPTIONAL_HEADER.CheckSum)
            self.assertEqual(len(patched.DIRECTORY_ENTRY_EXCEPTION), len(pe.DIRECTORY_ENTRY_EXCEPTION) + 2)
            section = patched.sections[-1]
            self.assertEqual(section.Name.rstrip(b"\0"), b".cuafix")
            callback = struct.unpack_from("<Q", candidate, patched.get_offset_from_rva(worker.VTABLE_ENTRY_RVA))[0]
            self.assertEqual(callback, patched.OPTIONAL_HEADER.ImageBase + section.VirtualAddress)
            self.assertTrue(any(e.rva == worker.VTABLE_ENTRY_RVA for block in patched.DIRECTORY_ENTRY_BASERELOC for e in block.entries))
            if sys.platform == "win32":
                import ctypes
                kernel = ctypes.WinDLL("kernel32", use_last_error=True)
                kernel.LoadLibraryExW.argtypes = [ctypes.c_wchar_p, ctypes.c_void_p, ctypes.c_uint32]
                kernel.LoadLibraryExW.restype = ctypes.c_void_p
                kernel.FreeLibrary.argtypes = [ctypes.c_void_p]
                # 仅验证 Windows 映射候选 PE，不执行入口、TLS 或截图业务。
                handle = kernel.LoadLibraryExW(str(target) + ".lite-frame-worker.stage", None, 1)
                self.assertTrue(handle, "Windows loader rejected candidate: " + str(ctypes.get_last_error()))
                kernel.FreeLibrary(handle)
            invoke(worker, "install", target)
            with self.assertRaises(RuntimeError):
                invoke(cursor, "restore", target)
            self.assertEqual(target.read_bytes(), candidate)
            invoke(worker, "restore", target)
            self.assertEqual(target.read_bytes(), first)
            invoke(cursor, "restore", target)
            self.assertEqual(target.read_bytes(), original)

    def test_unknown_helper_is_rejected_before_output(self):
        with tempfile.TemporaryDirectory(prefix="codex-lite-cua-") as directory:
            target = Path(directory) / "wrong.exe"
            target.write_bytes(b"MZwrong")
            with self.assertRaises(RuntimeError):
                invoke(cursor, "prepare", target)
            with self.assertRaises(RuntimeError):
                worker.prepare(target.read_bytes())
            self.assertEqual(len(list(Path(directory).iterdir())), 1)


if __name__ == "__main__":
    unittest.main()

"""Flipper Zero USB CLI transfer, with no replacement of existing files."""

from __future__ import annotations

import hashlib
import os
import re
import time
from pathlib import Path
from typing import Callable

import serial
from serial.tools import list_ports


DESTINATION = "/ext/fzmv"
KNOWN_IDS = {(0x0483, 0x5740)}
CHUNK_SIZE = 8192


class TransferError(Exception):
    pass


def find_devices() -> list[str]:
    """Identify USB CDC ports before opening them (never probe unrelated ports)."""
    devices = []
    for port in list_ports.comports():
        description = f"{port.description} {port.manufacturer or ''} {port.serial_number or ''}".lower()
        if (port.vid, port.pid) in KNOWN_IDS or "flipper" in description or "flip_" in description:
            devices.append(port.device)
    return devices


def validate_file(path: Path) -> None:
    if not path.is_file() or path.suffix.lower() != ".fzmv":
        raise TransferError(".fzmv ファイルを選択してください。")
    size = path.stat().st_size
    if not 64 <= size <= 0xFFFFFFFF:
        raise TransferError("FZMVファイルのサイズが不正です。")
    with path.open("rb") as stream:
        header = stream.read(64)
    if header[:4] != b"FZMV" or int.from_bytes(header[4:6], "little") not in (1, 2, 3, 4):
        raise TransferError("FZMVヘッダーを確認できません。")
    if int.from_bytes(header[44:48], "little") != size:
        raise TransferError("FZMVファイルの長さがヘッダーと一致しません。")


def safe_name(path: Path) -> str:
    # The device CLI uses ASCII for storage commands. Keep a recognizable
    # Latin filename, falling back to a timestamp for Japanese-only names.
    import unicodedata

    name = unicodedata.normalize("NFKD", path.stem).encode("ascii", "ignore").decode()
    name = re.sub(r"[^a-zA-Z0-9_-]+", "_", name).strip("_-")[:60]
    return name or f"clip_{time.strftime('%Y%m%d_%H%M%S')}"


class FlipperConnection:
    def __init__(self, port: str):
        self.port_name = port
        self.serial: serial.Serial | None = None
        self.buffer = bytearray()

    def __enter__(self) -> "FlipperConnection":
        try:
            self.serial = serial.Serial(self.port_name, 115200, timeout=0.5, write_timeout=30)
            time.sleep(0.35)
            self.read_until(b">: ", timeout=8)
            self.serial.reset_input_buffer()
            self.buffer.clear()
            result = self.command("device_info", timeout=8)
            if b"hardware_model" not in result:
                raise TransferError("接続先がFlipper Zeroであることを確認できませんでした。")
            return self
        except Exception:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_: object) -> None:
        if self.serial:
            self.serial.close()
            self.serial = None

    def read_until(self, token: bytes, timeout: float = 30) -> bytes:
        assert self.serial is not None
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            found = self.buffer.find(token)
            if found >= 0:
                output = bytes(self.buffer[:found])
                del self.buffer[: found + len(token)]
                return output
            incoming = self.serial.read(max(1, self.serial.in_waiting))
            if incoming:
                self.buffer.extend(incoming)
        raise TransferError("Flipper Zeroからの応答がありません。USB接続を確認してください。")

    def write(self, data: bytes) -> None:
        assert self.serial is not None
        self.serial.write(data)

    def command(self, command: str, timeout: float = 30) -> bytes:
        self.write(command.encode("ascii") + b"\r")
        self.read_until(b"\r\n", timeout)
        output = self.read_until(b">: ", timeout)
        if b"Storage error:" in output:
            raise TransferError(output.decode("ascii", "replace").strip())
        return output.strip()

    def stat(self, path: str) -> bytes | None:
        self.write(f'storage stat "{path}"\r'.encode("ascii"))
        self.read_until(b"\r\n")
        result = self.read_until(b">: ").strip()
        if (b"Storage error: file/dir not exist" in result or
                b"Storage error: file/dir doesn't exist" in result or
                b"Storage error: invalid name/path" in result):
            return None
        if b"Storage error:" in result:
            raise TransferError(result.decode("ascii", "replace"))
        return result

    def ensure_folder(self) -> None:
        if self.stat(DESTINATION) is None:
            self.command(f'storage mkdir "{DESTINATION}"')

    def available_name(self, name: str) -> str:
        for number in range(0, 10000):
            suffix = f"_{number}" if number else ""
            filename = f"{name[:60 - len(suffix)]}{suffix}.fzmv"
            path = f"{DESTINATION}/{filename}"
            if self.stat(path) is None:
                return path
        raise TransferError("同名ファイルが多すぎます。")

    def send(self, local: Path, progress: Callable[[int], None]) -> str:
        validate_file(local)
        self.ensure_folder()
        target = self.available_name(safe_name(local))
        size = local.stat().st_size
        sent = 0
        digest = hashlib.md5()
        # Choose a new, non-existing destination. Never overwrite user data.
        with local.open("rb") as stream:
            for chunk in iter(lambda: stream.read(CHUNK_SIZE), b""):
                self.write(f'storage write_chunk "{target}" {len(chunk)}\r'.encode("ascii"))
                self.read_until(b"\r\n", timeout=60)
                ready = self.read_until(b"\r\n", timeout=60)
                if b"Storage error:" in ready:
                    self.read_until(b">: ", timeout=60)
                    raise TransferError(ready.decode("ascii", "replace"))
                self.write(chunk)
                response = self.read_until(b">: ", timeout=60)
                if b"Storage error:" in response:
                    raise TransferError(response.decode("ascii", "replace"))
                digest.update(chunk)
                sent += len(chunk)
                progress(int(sent / size * 98))
        actual = self.command(f'storage md5 "{target}"', timeout=60).decode("ascii", "replace")
        if digest.hexdigest().lower() not in actual.lower():
            raise TransferError(f"転送後のMD5照合が失敗しました。端末側のファイル {target} を確認してください。")
        progress(100)
        return target


def transfer_file(path: Path, port: str, progress: Callable[[int], None]) -> str:
    with FlipperConnection(port) as device:
        return device.send(path, progress)

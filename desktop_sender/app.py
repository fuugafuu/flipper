"""Desktop launcher for verified, automatic Flipper Zero FZMV transfers."""

from __future__ import annotations

import queue
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from transfer import TransferError, find_devices, transfer_file, validate_file


BACKGROUND = "#0d1519"
PANEL = "#18272a"
ACCENT = "#ff8a36"
TEXT = "#f0f6ed"
MUTED = "#a7b8b2"


class SenderApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("FLIPFRAME | Flipper Zero 転送")
        self.root.geometry("710x610")
        self.root.minsize(600, 530)
        self.root.configure(bg=BACKGROUND)
        self.files: list[Path] = []
        self.devices: list[str] = []
        self.busy = False
        self.events: queue.Queue[tuple[str, object]] = queue.Queue()
        self.port = tk.StringVar(value="未接続")
        self.status = tk.StringVar(value="USBでFlipper Zeroを接続してください")
        self.progress = tk.IntVar(value=0)
        self.file_status = tk.StringVar(value=".fzmv ファイルを選択してください")
        self.make_ui()
        self.poll_events()
        self.refresh_devices()

    def label(self, parent, value, size=11, color=TEXT, bold=False, **kwargs):
        return tk.Label(parent, text=value, bg=kwargs.pop("bg", PANEL), fg=color,
                        font=("Yu Gothic UI", size, "bold" if bold else "normal"), **kwargs)

    def make_ui(self):
        tk.Frame(self.root, bg=ACCENT, height=5).pack(fill="x")
        header = tk.Frame(self.root, bg=BACKGROUND, padx=28, pady=23)
        header.pack(fill="x")
        self.label(header, "FLIPFRAME  /  TRANSFER", 20, ACCENT, True, bg=BACKGROUND).pack(anchor="w")
        self.label(header, "Flipper Zero USB ファイル転送", 11, MUTED, bg=BACKGROUND).pack(anchor="w", pady=(4, 0))

        device = tk.Frame(self.root, bg=PANEL, padx=22, pady=17)
        device.pack(fill="x", padx=26, pady=(0, 13))
        self.label(device, "01   接続デバイス", 12, bold=True).pack(anchor="w")
        row = tk.Frame(device, bg=PANEL)
        row.pack(fill="x", pady=(10, 2))
        self.device_choice = ttk.Combobox(row, textvariable=self.port, state="readonly", width=40)
        self.device_choice.pack(side="left", fill="x", expand=True)
        tk.Button(row, text="再検出", command=self.refresh_devices, bg="#294343", fg=TEXT,
                  activebackground="#355050", activeforeground=TEXT, relief="flat", padx=16, pady=6).pack(side="left", padx=(10, 0))
        self.label(device, "USB接続を自動認識します。複数台ある場合は選択できます。", 9, MUTED).pack(anchor="w", pady=(7, 0))

        files = tk.Frame(self.root, bg=PANEL, padx=22, pady=17)
        files.pack(fill="both", expand=True, padx=26, pady=(0, 13))
        self.label(files, "02   送信するFZMV", 12, bold=True).pack(anchor="w")
        top = tk.Frame(files, bg=PANEL)
        top.pack(fill="x", pady=(9, 8))
        tk.Button(top, text="＋ ファイルを選択", command=self.choose_files, bg="#294343", fg=TEXT,
                  activebackground="#355050", activeforeground=TEXT, relief="flat", padx=15, pady=7).pack(side="left")
        tk.Button(top, text="選択解除", command=self.clear_files, bg=PANEL, fg=MUTED,
                  activebackground=PANEL, activeforeground=TEXT, relief="flat", padx=12).pack(side="left", padx=9)
        self.listbox = tk.Listbox(files, bg="#111c1e", fg=TEXT, selectbackground="#38565a",
                                  relief="flat", highlightthickness=0, font=("Yu Gothic UI", 10), height=5)
        self.listbox.pack(fill="both", expand=True)
        self.label(files, "保存先  /ext/fzmv/   •   同じ名前は自動で連番保存", 9, MUTED).pack(anchor="w", pady=(8, 0))

        send = tk.Frame(self.root, bg=PANEL, padx=22, pady=18)
        send.pack(fill="x", padx=26, pady=(0, 22))
        self.label(send, "03   転送", 12, bold=True).pack(anchor="w")
        self.label(send, "転送完了時にFlipper側のMD5を照合します。", 9, MUTED).pack(anchor="w", pady=(5, 11))
        self.bar = ttk.Progressbar(send, maximum=100, variable=self.progress)
        self.bar.pack(fill="x", pady=(0, 6))
        self.label(send, "", 10, MUTED, textvariable=self.file_status).pack(anchor="w")
        self.label(send, "", 10, TEXT, textvariable=self.status, wraplength=600,
                   justify="left").pack(anchor="w", pady=(4, 10))
        self.send_button = tk.Button(send, text="FLIPPER ZERO に送信  →", command=self.start,
                                     bg=ACCENT, fg="#1a1410", activebackground="#ffa05b",
                                     activeforeground="#1a1410", font=("Yu Gothic UI", 12, "bold"),
                                     relief="flat", pady=11, state="disabled")
        self.send_button.pack(fill="x")
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("TProgressbar", background=ACCENT, troughcolor="#2e4547", bordercolor=PANEL)

    def refresh_devices(self):
        self.root.after(2500, self.refresh_devices)
        if self.busy:
            return
        try:
            devices = find_devices()
        except Exception as error:
            self.status.set(f"USBポートの取得に失敗しました: {error}")
            devices = []
        previous = self.port.get()
        self.devices = devices
        self.device_choice["values"] = devices
        self.port.set(previous if previous in devices else devices[0] if devices else "未接続")
        self.status.set(f"Flipper Zero候補を {len(devices)} 台検出しました" if devices else "Flipper ZeroをUSBで接続してください")
        self.update_button()

    def choose_files(self):
        if self.busy:
            return
        selected = filedialog.askopenfilenames(title="FZMVファイルを選択", filetypes=[("Flipper video", "*.fzmv")])
        if not selected:
            return
        for filename in selected:
            path = Path(filename)
            try:
                validate_file(path)
            except (TransferError, OSError) as error:
                messagebox.showerror("無効なファイル", f"{path.name}\n{error}")
                continue
            if path not in self.files:
                self.files.append(path)
                self.listbox.insert("end", f"  {path.name}  ({path.stat().st_size / 1024 / 1024:.2f} MB)")
        self.file_status.set(f"{len(self.files)} ファイルを選択中")
        self.update_button()

    def clear_files(self):
        if self.busy:
            return
        self.files.clear()
        self.listbox.delete(0, "end")
        self.file_status.set(".fzmv ファイルを選択してください")
        self.progress.set(0)
        self.update_button()

    def update_button(self):
        self.send_button.config(state="normal" if self.files and self.port.get() in self.devices and not self.busy else "disabled")

    def start(self):
        if self.busy or self.port.get() not in self.devices or not self.files:
            return
        self.busy = True
        self.update_button()
        self.progress.set(0)
        self.status.set("Flipper Zeroへ接続しています...")
        files = list(self.files)
        port = self.port.get()

        def worker():
            try:
                for i, path in enumerate(files, start=1):
                    self.events.put(("file", f"{i}/{len(files)}   {path.name}"))
                    destination = transfer_file(path, port, lambda value: self.events.put(("progress", value)))
                    self.events.put(("status", f"✓ 転送・照合完了  {destination}"))
                self.events.put(("done", len(files)))
            except Exception as error:
                self.events.put(("error", str(error)))

        threading.Thread(target=worker, daemon=True).start()

    def poll_events(self):
        try:
            while True:
                event, value = self.events.get_nowait()
                if event == "file":
                    self.file_status.set(str(value))
                    self.progress.set(0)
                elif event == "progress":
                    self.progress.set(int(value))
                elif event == "status":
                    self.status.set(str(value))
                elif event == "error":
                    self.busy = False
                    self.status.set(f"転送エラー  {value}")
                    self.update_button()
                    messagebox.showerror("転送エラー", str(value))
                elif event == "done":
                    self.busy = False
                    self.file_status.set(f"完了  {value} ファイル")
                    self.status.set("送信完了。Flipper ZeroのFZMV Playerから開けます。")
                    self.update_button()
        except queue.Empty:
            pass
        self.root.after(100, self.poll_events)


def main():
    root = tk.Tk()
    app = SenderApp(root)
    # Double-clicking an FZMV with the EXE path forwards the file to the picker.
    if len(sys.argv) > 1:
        for filename in sys.argv[1:]:
            path = Path(filename)
            try:
                validate_file(path)
                app.files.append(path)
                app.listbox.insert("end", f"  {path.name}")
            except (TransferError, OSError):
                pass
        app.file_status.set(f"{len(app.files)} ファイルを選択中")
        app.update_button()
    root.mainloop()


if __name__ == "__main__":
    main()

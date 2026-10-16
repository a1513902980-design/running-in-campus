#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
proc.py —— 受限 Windows 宿主下的子进程兼容层

问题
────
在一些受限执行环境里（沙箱化宿主、AppContainer 风格约束、某些 CI/EDR 环境），
**创建匿名管道会被拒绝**。于是任何想捕获子进程输出的调用直接失败：

    subprocess.run(cmd, capture_output=True)
      -> PermissionError: [WinError 5] 拒绝访问。
         File "subprocess.py", line 1005, in __init__
           errread, errwrite) = self._get_handles(stdin, stdout, stderr)
         File "subprocess.py", line 1390, in _get_handles
           c2pread, c2pwrite = _winapi.CreatePipe(None, 0)

这个报错的迷惑性在于：

  * 它**看起来**像权限问题 / 杀软拦截，实际是 `CreatePipe` 这个系统调用被拦；
  * 它**只**影响需要捕获输出的调用 —— 不需要捕获的调用（继承父进程 stdout）一切正常，
    所以很容易误判成"环境没问题，是我脚本写错了"；
  * `stdin=subprocess.DEVNULL` **修不好它**（那是另一个坑，见下）。

同族的第二个坑
──────────────
父进程的 stdin 句柄有时是"无效或不可继承"的（常见于被宿主以特殊方式启动的进程）。
子进程一旦尝试继承它，同样会在 `WinError 5` 上炸掉。所以除了输出，
**stdin 也必须显式给 DEVNULL**。

解法
────
把子进程的 stdout/stderr 从「管道」换成「**临时文件**」——同一个 API、同样的语义、
同样的返回值类型，但不碰管道的系统调用：

    subprocess.run(cmd, capture_output=True)   # ✗ 受限宿主必炸
    proc.run(cmd, capture_output=True)         # ✓ 先试管道，炸了自动改文件

设计取舍
────────
* **默认先试真管道**：正常终端里行为与标准库完全一致，零回归。
* 一旦探测到 `CreatePipe` 被拒，本进程内**永久切到文件模式**（`_MODE`），
  之后不再浪费时间试。
* 返回值仍是 `subprocess.CompletedProcess`（stdout/stderr 为 bytes 或 str），
  所以调用方只改一行。

★ 一个真实踩过的反模式
──────────────────────
为了"让老代码零改动"，最初写过：

    subprocess.run = proc.run          # ← 千万别这样

因为 `proc.run` 内部也调用 `subprocess.run`，这会造成**自调用**，运行时报：

    TypeError: run() got an unexpected keyword argument 'stdin'

正确做法只有两种：
    ① 模块别名：  import proc ;  proc.run(...)
    ② 显式调用：  proc.run(...)
本模块内部一律使用启动时**固定下来的原生引用**（`_NATIVE_RUN` / `_NATIVE_POPEN`），
从根上杜绝这个自调用问题。

用法
────
    import proc

    r = proc.run(["whoami"], capture_output=True, text=True, timeout=10)
    print(r.returncode, r.stdout)

    # 常驻后台进程（输出丢弃/落临时文件，返回值与 subprocess.Popen 一致）
    p = proc.popen_quiet(["my_daemon.exe", "--flag"])

    # 自检
    python proc.py
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile

_MODE = "auto"          # auto | pipe | file
_STDIN_GUARDED = False

# ★ 把「原生」对象固定下来。绝不要用 `subprocess.run = proc.run` 改全局
#   （会让本模块内部调用变成它自己，见文件头「反模式」一节）。
_NATIVE_RUN = subprocess.run
_NATIVE_POPEN = subprocess.Popen


def _guard_stdin() -> None:
    """给所有 Popen 补 stdin=DEVNULL。

    父进程 stdin 句柄无效/不可继承时，子进程继承它同样会 WinError 5。
    这一层很便宜，装上就不拆。
    """
    global _STDIN_GUARDED
    if _STDIN_GUARDED or getattr(_NATIVE_POPEN.__init__, "_stdin_guard", False):
        _STDIN_GUARDED = True
        return
    _orig = _NATIVE_POPEN.__init__

    def _patched(self, *a, **kw):
        kw.setdefault("stdin", subprocess.DEVNULL)
        return _orig(self, *a, **kw)

    _patched._stdin_guard = True   # type: ignore[attr-defined]
    _NATIVE_POPEN.__init__ = _patched
    _STDIN_GUARDED = True


_guard_stdin()


def pipe_ok() -> bool:
    """探测本机/本环境能否创建子进程管道。"""
    try:
        r = _NATIVE_RUN([sys.executable, "-c", "print(1)"],
                        capture_output=True, timeout=30, stdin=subprocess.DEVNULL)
        return r.returncode == 0
    except (PermissionError, OSError):
        return False


def _decode(b, text, encoding, errors):
    if b is None:
        return None
    if not text:
        return b
    return b.decode(encoding or "utf-8", errors or "replace")


def mode() -> str:
    """当前实际使用的模式：auto（还没试过）/ pipe / file。"""
    return _MODE


def run(cmd, capture_output: bool = False, text: bool = False, encoding=None,
        errors=None, timeout=None, cwd=None, env=None, input=None, check: bool = False,
        stdout=None, stderr=None, shell: bool = False):
    """`subprocess.run` 的替身：管道被禁时自动改用临时文件。

    支持 capture_output / text / encoding / errors / timeout / cwd / env /
    input(bytes|str) / check / stdout / stderr / shell。
    这里没覆盖的冷门参数请直接用 subprocess。
    """
    global _MODE
    _guard_stdin()

    want_out = capture_output or stdout == subprocess.PIPE
    want_err = capture_output or stderr == subprocess.PIPE
    err_merged = (stderr == subprocess.STDOUT)

    # input= 需要真 stdin 管道；受限宿主下给不出，退化成 DEVNULL
    stdin = subprocess.PIPE if input is not None else subprocess.DEVNULL

    kwargs = dict(timeout=timeout, cwd=cwd, env=env, shell=shell, stdin=stdin)
    if input is not None:
        kwargs["input"] = input if isinstance(input, bytes) else input.encode(encoding or "utf-8")

    if not want_out and not want_err:
        kwargs["stdout"] = stdout
        kwargs["stderr"] = stderr
        if text:
            kwargs["text"] = True
        if encoding:
            kwargs["encoding"] = encoding
        if errors:
            kwargs["errors"] = errors
        return _NATIVE_RUN(cmd, **kwargs)

    # ── 文件模式 ──
    # ★ 注意：这里绝不能把 capture_output/text/encoding 传给 subprocess.run：
    #   ① capture_output 与 stdout= 互斥（ValueError）；
    #   ② text 会让子进程按文本写，而我们后面还要按字节读临时文件。
    #   解码统一由 _decode() 在读完之后做。
    def _run_files():
        fo = tempfile.TemporaryFile() if want_out else None
        fe = None
        if err_merged and (want_out or want_err):
            fe = fo
        elif want_err:
            fe = tempfile.TemporaryFile()
        try:
            kw = dict(kwargs)
            kw["stdout"] = fo
            kw["stderr"] = fe if fe is not None else stderr
            r = _NATIVE_RUN(cmd, **kw)
            ob = b""
            if fo is not None:
                try:
                    fo.seek(0)
                    ob = fo.read()
                except Exception:
                    ob = b""
            eb = b""
            if not err_merged and fe is not None:
                try:
                    fe.seek(0)
                    eb = fe.read()
                except Exception:
                    eb = b""
            return subprocess.CompletedProcess(
                r.args, r.returncode,
                stdout=_decode(ob, text, encoding, errors),
                stderr=_decode(eb, text, encoding, errors))
        finally:
            for f in (fo, fe):
                if f is not None and f is not fo:
                    try:
                        f.close()
                    except Exception:
                        pass
            if fo is not None:
                try:
                    fo.close()
                except Exception:
                    pass

    if _MODE == "file":
        return _run_files()

    try:
        kw = dict(kwargs)
        kw["capture_output"] = capture_output
        if not capture_output:
            kw["stdout"] = stdout
            kw["stderr"] = stderr
        if text:
            kw["text"] = True
        if encoding:
            kw["encoding"] = encoding
        if errors:
            kw["errors"] = errors
        r = _NATIVE_RUN(cmd, **kw)
        _MODE = "pipe"
        return r
    except (PermissionError, OSError):
        # WinError 5 / EPERM：判定为本环境禁管道，之后一律走文件
        _MODE = "file"
        return _run_files()


def popen_quiet(cmd, cwd=None, env=None, text=False, encoding=None, errors=None, **kw):
    """后台常驻进程，输出落到临时文件（返回 Popen，与 subprocess.Popen 一致）。

    受限环境里 stdout/stderr 必须给「文件」而不是管道；句柄挂在进程对象上，
    进程结束自然回收。
    """
    _guard_stdin()
    kw = dict(cwd=cwd, env=env, stdin=subprocess.DEVNULL, **kw)
    if "stdout" not in kw:
        kw["stdout"] = tempfile.TemporaryFile()
    if "stderr" not in kw:
        kw["stderr"] = tempfile.TemporaryFile()
    if text:
        kw["text"] = True
    if encoding:
        kw["encoding"] = encoding
    if errors:
        kw["errors"] = errors
    p = _NATIVE_POPEN(cmd, **kw)
    # 挂到对象上，避免被 GC 提前关掉而让子进程写坏句柄
    setattr(p, "_quiet_files", [kw.get("stdout"), kw.get("stderr")])
    return p


def main() -> int:
    print("proc.py 自检：")
    print("  平台          : %s" % sys.platform)
    print("  允许建管道    : %s" % ("是" if pipe_ok() else "否（将自动改用临时文件）"))

    r = run([sys.executable, "-c", "import sys; print('hello from child'); print('warn', file=sys.stderr)"],
            capture_output=True, text=True, timeout=30)
    print("  测试子进程    : rc=%s" % r.returncode)
    print("    stdout      : %r" % (r.stdout or "").strip())
    print("    stderr      : %r" % (r.stderr or "").strip())
    print("  当前模式      : %s" % _MODE)

    # 合并 stderr 的用法
    r2 = run([sys.executable, "-c", "import sys; print('o'); print('e', file=sys.stderr)"],
             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=30)
    print("  合并输出      : %r" % (r2.stdout or "").strip())

    # 返回值类型与标准库一致
    print("  返回类型      : %s" % type(r).__name__)
    return 0


if __name__ == "__main__":
    sys.exit(main())

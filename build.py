#!/usr/bin/env python3
"""
ContractIQ Platform — build contractiq.jsx into app/ and demo/.

Run:  python3 build.py         (needs esbuild on PATH or in ./node_modules/.bin)

WHAT THIS DOES, AND THE TRAPS IT AVOIDS

  contractiq.jsx is the master source. app/index.html and demo/index.html
  are BUILD OUTPUTS — compiled, not written by hand. Editing them directly
  is how the source and the shipped app drifted apart before.

  1. React arrives as a UMD global from the CDN, so the `import` line is
     replaced with a destructure of window.React rather than bundled.
  2. `export default` is stripped for the same reason.
  3. `window.ContractIQ = ContractIQ` is appended BEFORE compiling.
     Without that anchor esbuild tree-shakes the whole component away and
     emits a 3KB file instead of a 370KB one, with no error.
  4. Non-ASCII characters are left as real characters, never \\uXXXX
     escapes — those land literally in JSX text and attribute positions.
  5. The two builds differ only in DEMO_MODE. The demo never calls the AI
     proxy, which is why turning JWT verification on does not break it.
"""
import os, re, subprocess, sys, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
SRC  = os.path.join(HERE, "contractiq.jsx")

def esbuild_bin():
    for c in [shutil.which("esbuild"),
              os.path.join(HERE, "node_modules/.bin/esbuild"),
              os.path.join(HERE, "..", "node_modules/.bin/esbuild")]:
        if c and os.path.exists(c):
            return c
    sys.exit("esbuild not found. npm install esbuild, or put it on PATH.")

def compile_bundle(demo: bool) -> str:
    src = open(SRC, encoding="utf-8").read()

    # 1 · React is a global here, not a module.
    src = re.sub(r'^\s*import\s+\{[^}]*\}\s+from\s+"react";\s*$',
                 "const { useState, useRef, useEffect, useCallback } = React;",
                 src, count=1, flags=re.M)
    if "import " in src.split("\n")[0]:
        sys.exit("The import line was not rewritten — check the first line of contractiq.jsx.")

    # 2 · No modules, so no default export.
    src = src.replace("export default function ContractIQ()", "function ContractIQ()", 1)

    # 3 · DEMO_MODE is the only difference between the two builds.
    src, n = re.subn(r"^const DEMO_MODE = (?:true|false);$",
                     f"const DEMO_MODE = {'true' if demo else 'false'};",
                     src, count=1, flags=re.M)
    if n != 1:
        sys.exit("Could not set DEMO_MODE — the declaration has moved.")

    # 4 · The anchor that stops the whole app being tree-shaken away.
    src += "\nwindow.ContractIQ = ContractIQ;\n"

    tmp = os.path.join(HERE, ".build.tmp.jsx")
    open(tmp, "w", encoding="utf-8").write(src)
    try:
        out = subprocess.run(
            [esbuild_bin(), tmp, "--loader:.jsx=jsx", "--jsx=transform",
             "--format=iife", "--target=es2020", "--charset=utf8"],
            capture_output=True, text=True, encoding="utf-8")
        if out.returncode != 0:
            sys.exit("esbuild failed:\n" + out.stderr)
        return out.stdout
    finally:
        os.remove(tmp)

def splice(html_path: str, bundle: str):
    """Replace the bundle <script> in an existing shell, leaving the rest alone."""
    html = open(html_path, encoding="utf-8").read()
    start = html.find("<script>\n(() => {\n  const { useState")
    if start == -1:
        sys.exit(f"Could not find the bundle script in {html_path}.")
    end = html.find("</script>", start)
    if end == -1:
        sys.exit(f"Unterminated bundle script in {html_path}.")
    new = html[:start] + "<script>\n" + bundle + "</script>" + html[end + len("</script>"):]
    open(html_path, "w", encoding="utf-8").write(new)
    return len(bundle)

def main():
    for path, demo in [("app/index.html", False), ("demo/index.html", True)]:
        full = os.path.join(HERE, path)
        size = splice(full, compile_bundle(demo))
        # Checks worth failing the build over, because each one has shipped
        # broken at least once.
        out = open(full, encoding="utf-8").read()
        problems = []
        if size < 100_000:
            problems.append(f"bundle is only {size} bytes — the tree-shake anchor is probably missing")
        if "window.ContractIQ" not in out:
            problems.append("window.ContractIQ anchor missing from the output")
        if re.search(r'"[^"]*\\u[0-9a-fA-F]{4}[^"]*"\s*[,)]', out) and "\\u2318" in out:
            problems.append("literal \\uXXXX escapes found in the output")
        if problems:
            sys.exit(f"{path}: " + "; ".join(problems))
        print(f"  {path}: {size:,} bytes, DEMO_MODE={'true' if demo else 'false'}  ok")

    print("Build complete. Test the BUILT files, not contractiq.jsx.")

if __name__ == "__main__":
    main()

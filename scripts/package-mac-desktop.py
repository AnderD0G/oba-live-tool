"""Archive the complete current Electron desktop source, never a user profile."""
from pathlib import Path
import hashlib
import json
import sys
import time
import zipfile

ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
OUTPUT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / 'artifacts' / 'mac-deployment' / f'oba-mac-desktop-{VERSION}.zip'
if OUTPUT.exists():
    raise SystemExit('Refusing to overwrite a previously delivered package')

DIRECTORIES = ['src', 'electron', 'shared', 'public', 'assets', 'deploy/voice-container']
FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', '.gitignore',
         'index.html', 'vite.config.ts', 'tsconfig.json', 'tsconfig.node.json',
         'electron-builder.json', 'components.json', 'biome.json', 'providers.json',
         'LICENSE', 'THIRD-PARTY-NOTICES.txt', 'INSTALL-GUIDE.txt',
         'deploy/mac-desktop/README.md',
         'scripts/build-analysis-capture-worker.mjs', 'scripts/build-mac-desktop.cjs',
         'scripts/import-desktop-assistant-config.mjs', 'scripts/package-mac-desktop.py',
         'scripts/mcp-director-server.mjs', 'scripts/export-assistant-mac-config.mjs',
         'scripts/oba-user-data-candidates.mjs', 'scripts/smoke-desktop-config-import.mjs',
         'scripts/analysis-release-contract.mjs', 'scripts/oba-director-mcp.cmd',
         'scripts/tk-capture-api.mjs', 'scripts/tk-attach-existing-chrome.mjs',
         'tests/macDesktopBuild.test.ts', 'tests/desktopLanding.test.ts',
         'tests/macMcpDiscovery.test.ts', 'tests/desktopConfigImport.test.ts']
REQUIRED = ['src/main.tsx', 'src/App.tsx', 'src/pages/AssistantDesk/index.tsx',
            'src/pages/AssistantDesk/AssistantDeskView.tsx', 'src/router/index.tsx',
            'electron/preload/index.ts', 'electron/main/index.ts', 'electron/main/app.ts',
            'electron/main/desktopLanding.ts', 'scripts/build-analysis-capture-worker.mjs',
            'scripts/build-mac-desktop.cjs', 'scripts/import-desktop-assistant-config.mjs',
            'public/assistant-mobile/index.html', 'public/favicon.png', *FILES]
BLOCKED_PARTS = {'node_modules', '.git', 'cookies', 'backups', 'logs', '__pycache__',
                 'artifacts', 'release', 'vendor-build', 'dist', 'dist-electron', 'profiles'}


def allowed(path):
    relative = path.relative_to(ROOT)
    if path.is_symlink() or not path.resolve().is_relative_to(ROOT) or any(part.lower() in BLOCKED_PARTS for part in relative.parts):
        return False
    lower = path.name.lower()
    if lower.startswith('.env') or lower.endswith(('.env', '.local', '.sqlite', '.sqlite3', '.sqlite-wal', '.sqlite-shm', '.db', '.db-wal', '.db-shm', '.jsonl', '.log', '.wav', '.exe', '.pyc', '.pem', '.key', '.pfx')):
        return False
    if lower in {'director-api.json', 'admin-token.txt', 'settings.json', 'cookies.json', 'host-token', 'api-key', 'secrets.json', 'local state'} or 'credentials' in lower or 'token.txt' in lower:
        return False
    return True


paths = set()
for name in DIRECTORIES:
    folder = ROOT / name
    if not folder.is_dir():
        raise SystemExit(f'Missing desktop source directory: {name}')
    paths.update(path for path in folder.rglob('*') if path.is_file() and allowed(path))
for name in FILES:
    path = ROOT / name
    if not path.is_file() or not allowed(path):
        raise SystemExit(f'Missing or excluded desktop input: {name}')
    paths.add(path)
names = {path.relative_to(ROOT).as_posix() for path in paths}
for name in REQUIRED:
    if name not in names:
        raise SystemExit(f'Missing required desktop input: {name}')

entries = []
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(OUTPUT, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for path in sorted(paths):
        relative = path.relative_to(ROOT).as_posix()
        data = path.read_bytes()
        archive.writestr('oba-mac-desktop/' + relative, data)
        entries.append({'path': relative, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    start_here = (ROOT / 'deploy/mac-desktop/README.md').read_bytes()
    archive.writestr('oba-mac-desktop/START-HERE-MAC.md', start_here)
    entries.append({'path': 'START-HERE-MAC.md', 'bytes': len(start_here), 'sha256': hashlib.sha256(start_here).hexdigest()})
    manifest = {'format': 'oba-full-desktop-source', 'version': VERSION, 'createdAt': int(time.time()),
                'entryPoint': 'START-HERE-MAC.md', 'desktopRendererIncluded': True,
                'includesRuntimeUserData': False, 'macRuntimeVerified': False, 'files': entries}
    archive.writestr('oba-mac-desktop/PACKAGE-MANIFEST.json', json.dumps(manifest, ensure_ascii=False, indent=2))
with zipfile.ZipFile(OUTPUT) as archive:
    assert archive.testzip() is None
    for name in archive.namelist():
        assert name.startswith('oba-mac-desktop/') and '..' not in Path(name).parts
    for entry in entries:
        assert hashlib.sha256(archive.read('oba-mac-desktop/' + entry['path'])).hexdigest() == entry['sha256']
print(json.dumps({'file': str(OUTPUT), 'files': len(entries), 'bytes': OUTPUT.stat().st_size,
                  'sha256': hashlib.sha256(OUTPUT.read_bytes()).hexdigest(), 'verified': True,
                  'desktopRendererIncluded': True, 'macRuntimeVerified': False}))

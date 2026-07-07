# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['C:\\Users\\xhan1\\lumendeck\\bridge\\server.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=['diffusers_backend'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['numpy', 'cv2', 'PIL', 'torch', 'torchvision', 'diffusers', 'transformers', 'scipy', 'controlnet_aux', 'timm', 'safetensors', 'huggingface_hub', 'accelerate', 'kornia', 'einops', 'matplotlib'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='lumendeck-bridge',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

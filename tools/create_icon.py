"""Convert the shared application logo to a multi-size Windows icon."""
from pathlib import Path
from PIL import Image


def create_icon(path):
    source = Path(__file__).resolve().parents[1] / 'app/logo.png'
    path.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as image:
        image.convert('RGBA').save(path, format='ICO', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

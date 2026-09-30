"""Hằng số & tiện ích thương hiệu MBV dùng chung (màu, font, logo).

Dùng:
    import sys; sys.path.insert(0, "<skill>/scripts")
    import mbv_brand as B
    B.RED, B.hex_rgb(B.RED), B.logo_path("white")
"""
import os

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(SKILL_DIR, "assets")

# --- Màu (HEX không có #) ---
RED = "B61D22"       # chủ đạo
DEEP_RED = "8A1418"  # hover / nền tối phụ
GOLD = "FCC743"      # điểm nhấn, ngôi sao
INK = "1C1C1E"       # chữ chính
STONE = "F4F1EC"     # nền phụ
WHITE = "FFFFFF"
GREY = "6B6B70"      # chữ phụ
LINE = "D9D5CE"      # đường kẻ
PALETTE = {"RED": RED, "DEEP_RED": DEEP_RED, "GOLD": GOLD, "INK": INK,
           "STONE": STONE, "WHITE": WHITE, "GREY": GREY, "LINE": LINE}

# --- Font ---
FONT = "Liberation Sans"
FONT_FALLBACKS = ("Arial", "Helvetica", "sans-serif")
FONT_DIR = "/usr/share/fonts/truetype/liberation"
FONT_FILES = {"R": "LiberationSans-Regular.ttf", "B": "LiberationSans-Bold.ttf",
              "I": "LiberationSans-Italic.ttf", "BI": "LiberationSans-BoldItalic.ttf"}

# --- Logo ---
LOGO_RATIO = 1055 / 425   # rộng / cao
STAR_RATIO = 254 / 256
_LOGOS = {"color": "logo_color.png", "white": "logo_white.png",
          "mono": "logo_mono.png", "red": "logo_red.png"}


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def hex_float(h):
    return tuple(v / 255 for v in hex_rgb(h))


def logo_path(mode="color"):
    """mode: color (nền sáng) | white (nền đỏ/tối) | mono (đen) | red (một màu đỏ)."""
    return os.path.join(ASSETS, _LOGOS[mode])


def star_path(mode="color"):
    return os.path.join(ASSETS, "star_white.png" if mode == "white" else "star_color.png")


def logo_for_background(bg_hex):
    """Chọn bản logo hợp với màu nền."""
    r, g, b = hex_rgb(bg_hex)
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    if bg_hex.upper() == GOLD:
        return "mono"
    return "color" if lum > 140 else "white"


def register_reportlab_fonts():
    """Đăng ký Liberation Sans cho ReportLab với tên 'MBV', 'MBV-Bold', 'MBV-Italic'."""
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    for key, name in (("R", "MBV"), ("B", "MBV-Bold"), ("I", "MBV-Italic")):
        pdfmetrics.registerFont(TTFont(name, os.path.join(FONT_DIR, FONT_FILES[key])))
    return "MBV", "MBV-Bold", "MBV-Italic"


def draw_logo(canvas, x, y, width, mode="color"):
    """Vẽ logo lên ReportLab canvas, giữ đúng tỷ lệ. (x, y) = góc dưới trái."""
    canvas.drawImage(logo_path(mode), x, y, width, width / LOGO_RATIO, mask="auto")
    return width / LOGO_RATIO


def draw_star(canvas, cx, cy, size, mode="color"):
    canvas.drawImage(star_path(mode), cx - size / 2, cy - size / 2, size, size, mask="auto")

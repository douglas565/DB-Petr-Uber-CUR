# app.py
import webview
import os
import sys

def resource_path(relative_path):
    """Retorna o caminho absoluto para um recurso empacotado (útil para PyInstaller)."""
    try:
        base_path = sys._MEIPASS
    except Exception:
        base_path = os.path.abspath(".")
    return os.path.join(base_path, relative_path)

if __name__ == "__main__":
    html = resource_path("index.html")
    window = webview.create_window(
        title="Dashboard Depreciação",
        url=html,
        width=1280,
        height=800,
        resizable=True
    )
    webview.start()
# Download script for UI/UX Pro Max skill files
import urllib.request
import os
from pathlib import Path

BASE_URL = "https://raw.githubusercontent.com/nextlevelbuilder/ui-ux-pro-max-skill/main/.shared/ui-ux-pro-max"
SKILL_DIR = Path(r"c:\Users\Administrator\Desktop\Antigravity-admin\.agent\skills\ui-ux-pro-max")

# Python scripts to download
SCRIPTS = [
    "scripts/search.py",
    "scripts/core.py",
    "scripts/design_system.py"
]

# Data CSV files to download
DATA_FILES = [
    "data/charts.csv",
    "data/colors.csv",
    "data/icons.csv",
    "data/landing.csv",
    "data/products.csv",
    "data/prompts.csv",
    "data/react-performance.csv",
    "data/styles.csv",
    "data/typography.csv",
    "data/ui-reasoning.csv",
    "data/ux-guidelines.csv",
    "data/web-interface.csv"
]

# Stack-specific files
STACK_FILES = [
    "data/stacks/flutter.csv",
    "data/stacks/html-tailwind.csv",
    "data/stacks/jetpack-compose.csv",
    "data/stacks/nextjs.csv",
    "data/stacks/nuxt-ui.csv",
    "data/stacks/nuxtjs.csv",
    "data/stacks/react-native.csv",
    "data/stacks/react.csv",
    "data/stacks/shadcn.csv",
    "data/stacks/svelte.csv",
    "data/stacks/swiftui.csv",
    "data/stacks/vue.csv"
]

def download_file(url, dest_path):
    """Download a file from URL to destination path"""
    try:
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        print(f"Downloading: {dest_path.name}...", end=" ")
        urllib.request.urlretrieve(url, dest_path)
        print("✓")
        return True
    except Exception as e:
        print(f"✗ Error: {e}")
        return False

def main():
    print("=" * 60)
    print("UI/UX Pro Max Skill - File Downloader")
    print("=" * 60)
    
    total_files = len(SCRIPTS) + len(DATA_FILES) + len(STACK_FILES)
    downloaded = 0
    failed = 0
    
    all_files = [
        ("Scripts", SCRIPTS),
        ("Core Data", DATA_FILES),
        ("Stack Files", STACK_FILES)
    ]
    
    for category, files in all_files:
        print(f"\n{category}:")
        print("-" * 60)
        for file_path in files:
            url = f"{BASE_URL}/{file_path}"
            dest = SKILL_DIR / file_path
            if download_file(url, dest):
                downloaded += 1
            else:
                failed += 1
    
    print("\n" + "=" * 60)
    print(f"Download Complete!")
    print(f"  ✓ Success: {downloaded}/{total_files}")
    if failed > 0:
        print(f"  ✗ Failed: {failed}/{total_files}")
    print("=" * 60)

if __name__ == "__main__":
    main()

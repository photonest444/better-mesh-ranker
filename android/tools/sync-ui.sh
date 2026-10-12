#!/usr/bin/env bash
# Копирует общий интерфейс и ядро в assets Android-приложения.
# Обычно не нужен: то же самое делает Gradle-задача syncSharedUi при сборке.
# Полезен, если вы открываете проект в Android Studio и видите старые assets.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
assets="$root/android/app/src/main/assets"

mkdir -p "$assets"
rm -rf "$assets/ui" "$assets/core"
cp -R "$root/shared/ui" "$assets/ui"
cp -R "$root/shared/core" "$assets/core"

echo "Скопировано:"
echo "  shared/ui   → android/app/src/main/assets/ui"
echo "  shared/core → android/app/src/main/assets/core"

#!/usr/bin/env bash
# Устанавливает workflow-файлы GitHub Actions из каталога ci/ в .github/workflows/.
#
# Зачем это нужно: каталог .github/workflows требует у токена права «workflows».
# Если ваша машина/токен таким правом не обладает (например, GitHub App в Arena),
# файлы лежат в ci/ — версионируются как обычные файлы — а этот скрипт
# раскладывает их на место, после чего достаточно закоммитить и запушить.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$root/.github/workflows"
cp "$root"/ci/*.yml "$root/.github/workflows/"
echo "Установлены workflow-файлы:"
ls -1 "$root/.github/workflows"
echo
echo "Дальше:"
echo "  git add .github/workflows && git commit -m \"CI: сборка Windows/Linux/Android\" && git push"

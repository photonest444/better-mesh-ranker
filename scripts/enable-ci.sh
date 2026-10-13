#!/usr/bin/env bash
# Проверяет/устанавливает workflow-файлы GitHub Actions.
#
# Источник правды — каталог .github/workflows: он уже в репозитории, и правки
# в main / arena/** запускают проверки автоматически. Этот скрипт остался для
# совместимости: если каталог ci/ существует (запасной вариант для машины или
# токена без права «workflows»), файлы копируются оттуда; если нет — скрипт
# просто подтверждает, что workflow уже на месте.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$root/.github/workflows"

if compgen -G "$root/ci/*.yml" > /dev/null; then
  cp "$root"/ci/*.yml "$root/.github/workflows/"
  echo "Установлены workflow-файлы из ci/:"
  echo "  git add .github/workflows && git commit -m \"CI: сборка Windows/Linux/Android\" && git push"
else
  echo "Каталог ci/ не найден — workflow уже лежат в .github/workflows:"
fi
ls -1 "$root/.github/workflows"

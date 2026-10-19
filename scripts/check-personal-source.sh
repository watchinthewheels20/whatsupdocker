#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Fail before publishing if a checkout accidentally points at upstream WUD.
for source_file in \
  app/updates/service.ts app/updates/compose.ts \
  app/schedules/index.ts app/schedules/store.ts \
  app/api/updates.ts app/api/schedule.ts \
  ui/src/components/BulkUpdateDialog.vue \
  ui/src/components/ScheduleDialog.vue ui/src/views/SchedulesView.vue; do
  if [[ ! -s "$source_file" ]]; then
    echo "Personal update management source missing: $source_file" >&2
    exit 1
  fi
done
grep -Fq "'/updates'" app/api/api.ts
grep -Fq "'/schedules'" app/api/api.ts
grep -Fq SchedulesView ui/src/router/index.ts
grep -Fq BulkUpdateDialog ui/src/views/ContainersView.vue
echo 'Personal update management source and route wiring are present.'

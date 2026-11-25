#!/usr/bin/env bash
set -Eeuo pipefail

# Sauvegarde hebdomadaire chiffrée vers un bucket Neon Object Storage d'un second projet.
: "${DATABASE_URL:?DATABASE_URL manquant}"
: "${AGE_RECIPIENT:?AGE_RECIPIENT manquant}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID manquant}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY manquant}"
: "${AWS_ENDPOINT_URL_S3:?AWS_ENDPOINT_URL_S3 manquant}"
: "${AWS_REGION:?AWS_REGION manquant}"
: "${AWS_S3_BUCKET:?AWS_S3_BUCKET manquant}"

for cmd in docker age aws node; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "$cmd requis" >&2; exit 2; }
done

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
DUMP="$TMP_DIR/mapnifique-$STAMP.dump"
ENCRYPTED="$DUMP.age"
KEY="weekly/mapnifique-$STAMP.dump.age"

# Neon Free est limité à 1 Go de données. Docker utilise exactement le client PostgreSQL 17.
docker run --rm -e DATABASE_URL="$DATABASE_URL" -v "$TMP_DIR:/backup" \
  postgres:17-alpine pg_dump --format=custom --no-owner --no-acl \
  --file="/backup/$(basename "$DUMP")" "$DATABASE_URL"
DUMP_BYTES="$(stat -c '%s' "$DUMP")"
MAX_DUMP_BYTES="${MAX_DUMP_BYTES:-900000000}"
[[ "$DUMP_BYTES" -le "$MAX_DUMP_BYTES" ]] || { echo "Dump trop volumineux ($DUMP_BYTES octets); aucun upload." >&2; exit 3; }

age --recipient "$AGE_RECIPIENT" --output "$ENCRYPTED" "$DUMP"
aws s3 cp "$ENCRYPTED" "s3://$AWS_S3_BUCKET/$KEY" \
  --endpoint-url "$AWS_ENDPOINT_URL_S3" --region "$AWS_REGION" \
  --only-show-errors --no-progress
aws s3api head-object --bucket "$AWS_S3_BUCKET" --key "$KEY" \
  --endpoint-url "$AWS_ENDPOINT_URL_S3" --region "$AWS_REGION" >/dev/null

# Rétention de quatre sauvegardes hebdomadaires, avec plafond strict sous les 5 Go inclus.
aws s3api list-objects-v2 --bucket "$AWS_S3_BUCKET" --prefix weekly/ \
  --endpoint-url "$AWS_ENDPOINT_URL_S3" --region "$AWS_REGION" \
  --output json > "$TMP_DIR/list.json"
node --input-type=module - "$TMP_DIR/list.json" "$AWS_S3_BUCKET" "$AWS_ENDPOINT_URL_S3" "$AWS_REGION" <<'NODE'
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const [file,bucket,endpoint,region]=process.argv.slice(2);
const data=JSON.parse(fs.readFileSync(file,'utf8'));
const rows=(data.Contents||[]).filter(x=>x.Key?.endsWith('.dump.age'))
  .sort((a,b)=>String(b.LastModified).localeCompare(String(a.LastModified)));
for (const item of rows.slice(4)) {
  execFileSync('aws',['s3api','delete-object','--bucket',bucket,'--key',item.Key,
    '--endpoint-url',endpoint,'--region',region,'--output','json'],{stdio:'ignore'});
}
const retained=rows.slice(0,4);
const bytes=retained.reduce((sum,x)=>sum+Number(x.Size||0),0);
if (bytes>4_800_000_000) throw new Error(`Sauvegardes > 4,8 Go (${bytes}); vérifie la rétention et la taille du bucket.`);
if (!retained.length) throw new Error('Aucune sauvegarde trouvée après upload.');
console.log(`BACKUP_UPLOAD=PASS retained=${retained.length} bytes=${bytes}`);
NODE

echo "BACKUP_OBJECT=$KEY"
echo "BACKUP_DUMP_BYTES=$DUMP_BYTES"
echo 'BACKUP_ENCRYPTED=PASS'

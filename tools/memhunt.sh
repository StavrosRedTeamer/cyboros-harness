#!/system/bin/sh
# memhunt.sh v3 — scan a frozen process's readable memory (anonymous + file-backed,
# incl. the AOT snapshot mapped from libapp.so where Dart string constants live)
# for "MECCANISMI" (UTF-16LE) and candidate tokens, dumping surrounding context.
# Usage (root): sh /data/local/tmp/memhunt.sh <pid>
PID="$1"
[ -z "$PID" ] && { echo "usage: memhunt.sh <pid>"; exit 1; }
OUT=/data/local/tmp/memhunt.out
CTX=/data/local/tmp/memhunt.ctx
: > "$OUT"
: > "$CTX"

kill -CONT "$PID" 2>/dev/null
kill -STOP "$PID" 2>/dev/null
RESUME=1
cleanup() { [ "$RESUME" = 1 ] && kill -CONT "$PID" 2>/dev/null; }
trap cleanup EXIT

# All readable regions (field2 has r; includes file-backed paths, unlike v2).
# Skip huge device/framework mappings to stay fast; keep app .so/.art/.vdex + anon.
awk '$2 ~ /^r/ {
  if ($6 == "" || $6 ~ /com\.example\.fest|libapp|app_flutter|base\.(art|oat|vdex)/) print $1, $2, $6
}' /proc/$PID/maps | while read rng perm path; do
  start=$(echo "$rng" | cut -d- -f1); end=$(echo "$rng" | cut -d- -f2)
  s=$((16#$start)); e=$((16#$end))
  s=$((s & ~4095))
  len=$((e - s))
  [ "$len" -le 0 ] && continue
  [ "$len" -gt 67108864 ] && continue   # skip >64MB mappings
  dd if=/proc/$PID/mem bs=4096 skip=$((s / 4096)) count=$(((len + 4095) / 4096)) conv=noerror,sync 2>/dev/null > /data/local/tmp/.mh.raw
  # UTF-16LE "MECCANISMI..." -> strip NULs then grep (works for BOTH encodings).
  # The value adjacent to the header name in the snapshot lands in the same match.
  tr -d '\000' < /data/local/tmp/.mh.raw | grep -aoE 'MECCANISMI[[:print:]]{0,140}' | while read hit; do
    echo "@$path :: $hit" >> "$CTX"
  done
  # standalone token candidates from this region (UTF-16/ASCII agnostic after NUL strip)
  tr -d '\000' < /data/local/tmp/.mh.raw | grep -aoE '[A-Za-z0-9._:@/=+-]{20,64}' >> "$OUT"
done
rm -f /data/local/tmp/.mh.raw

RESUME=0
kill -CONT "$PID" 2>/dev/null
trap - EXIT
echo "== context hits =="
sort -u "$CTX" | head -40
echo "== token candidates =="
sort -u "$OUT" | grep -vE '^(MECCANISMI\.CLOUD|MECCANISMI-API-KEY)' | head -100
echo "== scan done =="
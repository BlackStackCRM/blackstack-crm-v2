$b = '{"email":"probe-nonexistent@example.invalid","password":"wrongpass"}'
try {
  $r = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/api/auth/login -ContentType 'application/json' -Method POST -Body $b -TimeoutSec 30
  "status: $($r.StatusCode)"
  $r.Content
} catch {
  $resp = $_.Exception.Response
  if ($resp) {
    "status: $([int]$resp.StatusCode)"
    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $reader.ReadToEnd()
  } else { "FAILED: $($_.Exception.Message)" }
}

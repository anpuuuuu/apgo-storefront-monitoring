param(
  [string]$PrivateKeyPath = '',

  [string]$AppId = '',

  [string]$CentralRepository = 'anpuuuuu/apgo-storefront-monitoring',
  [string]$WebhookUrl = 'https://apgo-monitor-dispatcher.wadeyeh.workers.dev/github/webhook',
  [string]$WranglerConfig = 'workers/dispatcher/wrangler.jsonc',
  [string]$SecretSourceUrl = '',
  [switch]$BootstrapOnly
)

$ErrorActionPreference = 'Stop'

function ConvertTo-Base64Url {
  param([byte[]]$Bytes)
  return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Invoke-SecretProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FileName,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$SecretValue
  )

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FileName
  foreach ($argument in $ArgumentList) {
    [void]$startInfo.ArgumentList.Add($argument)
  }
  $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  $process = [System.Diagnostics.Process]::Start($startInfo)
  $process.StandardInput.Write($SecretValue)
  $process.StandardInput.Close()
  $standardOutput = $process.StandardOutput.ReadToEnd()
  $standardError = $process.StandardError.ReadToEnd()
  $process.WaitForExit()

  if ($process.ExitCode -ne 0) {
    throw "Secret command failed with exit $($process.ExitCode): $standardError"
  }

  return ($standardOutput + $standardError).Trim()
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$resolvedWranglerConfig = Join-Path $repositoryRoot $WranglerConfig
if (-not (Test-Path -LiteralPath $resolvedWranglerConfig -PathType Leaf)) {
  throw "Wrangler config was not found at $resolvedWranglerConfig"
}

if (-not $BootstrapOnly) {
  if (-not $AppId) {
    throw 'AppId is required unless -BootstrapOnly is used'
  }
  if (-not $PrivateKeyPath -or -not (Test-Path -LiteralPath $PrivateKeyPath -PathType Leaf)) {
    throw "Private key was not found at $PrivateKeyPath"
  }
}

$rsa = $null
$hmac = $null
$webhookSecret = $null
$secretBytes = $null
$jwt = $null
$updateBody = $null

try {
  if (-not $BootstrapOnly) {
    # Authenticate and prove the App owns an active hook before rotating any
    # shared secret. A wrong App ID/key therefore cannot break production.
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $headerJson = '{"alg":"RS256","typ":"JWT"}'
    $payloadJson = @{
      iat = $now - 60
      exp = $now + 540
      iss = $AppId
    } | ConvertTo-Json -Compress
    $header = ConvertTo-Base64Url -Bytes ([Text.Encoding]::UTF8.GetBytes($headerJson))
    $payload = ConvertTo-Base64Url -Bytes ([Text.Encoding]::UTF8.GetBytes($payloadJson))
    $unsignedToken = "$header.$payload"

    $rsa = [Security.Cryptography.RSA]::Create()
    $rsa.ImportFromPem((Get-Content -Raw -LiteralPath $PrivateKeyPath))
    $signature = $rsa.SignData(
      [Text.Encoding]::UTF8.GetBytes($unsignedToken),
      [Security.Cryptography.HashAlgorithmName]::SHA256,
      [Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    $jwt = "$unsignedToken.$(ConvertTo-Base64Url -Bytes $signature)"
    $apiHeaders = @{
      Authorization = "Bearer $jwt"
      Accept = 'application/vnd.github+json'
      'X-GitHub-Api-Version' = '2026-03-10'
    }

    $appIdentity = Invoke-RestMethod `
      -Method Get `
      -Uri 'https://api.github.com/app' `
      -Headers $apiHeaders
    Write-Output "Authenticated GitHub App: $($appIdentity.slug) ($($appIdentity.id))"

    $hookProbe = Invoke-WebRequest `
      -Method Get `
      -Uri 'https://api.github.com/app/hook/config' `
      -Headers $apiHeaders `
      -SkipHttpErrorCheck
    Write-Output "GitHub hook configuration probe: HTTP $($hookProbe.StatusCode)"
    if ($hookProbe.StatusCode -ne 200) {
      throw "GitHub App hook is not ready (HTTP $($hookProbe.StatusCode)); no secrets were changed"
    }
  }

  if ($SecretSourceUrl) {
    $webhookSecret = (Invoke-WebRequest -Uri $SecretSourceUrl -UseBasicParsing).Content
  }
  else {
    $secretBytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
    $webhookSecret = [Convert]::ToHexString($secretBytes).ToLowerInvariant()
  }

  [void](Invoke-SecretProcess `
    -FileName 'gh.exe' `
    -ArgumentList @('secret', 'set', 'MONITOR_GITHUB_WEBHOOK_SECRET', '--repo', $CentralRepository) `
    -WorkingDirectory $repositoryRoot `
    -SecretValue $webhookSecret)

  [void](Invoke-SecretProcess `
    -FileName 'cmd.exe' `
    -ArgumentList @('/d', '/s', '/c', "npx.cmd wrangler secret put GITHUB_WEBHOOK_SECRET --config $WranglerConfig") `
    -WorkingDirectory $repositoryRoot `
    -SecretValue $webhookSecret)

  if ($BootstrapOnly) {
    Write-Output 'GitHub and Cloudflare webhook secrets synchronized for bootstrap.'
    return
  }

  $updateBody = @{
    url = $WebhookUrl
    content_type = 'json'
    insecure_ssl = '0'
    secret = $webhookSecret
  } | ConvertTo-Json -Compress

  [void](Invoke-RestMethod `
    -Method Patch `
    -Uri 'https://api.github.com/app/hook/config' `
    -Headers $apiHeaders `
    -ContentType 'application/json' `
    -Body $updateBody)

  Start-Sleep -Seconds 3

  $pingBody = '{"zen":"dispatcher exact secret verification"}'
  $hmac = [Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($webhookSecret))
  $pingSignature = 'sha256=' + [Convert]::ToHexString(
    $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($pingBody))
  ).ToLowerInvariant()
  $pingHeaders = @{
    'x-hub-signature-256' = $pingSignature
    'x-github-delivery' = [guid]::NewGuid().ToString()
    'x-github-event' = 'ping'
  }
  $pingResponse = Invoke-WebRequest `
    -Method Post `
    -Uri $WebhookUrl `
    -Headers $pingHeaders `
    -ContentType 'application/json' `
    -Body $pingBody `
    -SkipHttpErrorCheck

  $hookConfig = Invoke-RestMethod `
    -Method Get `
    -Uri 'https://api.github.com/app/hook/config' `
    -Headers $apiHeaders

  if ($pingResponse.StatusCode -ne 202) {
    throw "Dispatcher rejected a correctly signed ping with HTTP $($pingResponse.StatusCode)"
  }
  $pingJson = $pingResponse.Content | ConvertFrom-Json
  if ($pingJson.ok -ne $true -or $pingJson.ignored -ne 'ignored event') {
    throw 'Dispatcher returned an unexpected response to the signed ping'
  }
  if ($hookConfig.url -ne $WebhookUrl -or $hookConfig.content_type -ne 'json' -or [string]$hookConfig.insecure_ssl -ne '0') {
    throw 'GitHub App webhook configuration did not match the requested secure configuration'
  }

  Write-Output "GitHub hook configured: $($hookConfig.url)"
  Write-Output 'Dispatcher signed ping accepted: HTTP 202'
}
finally {
  if ($null -ne $rsa) { $rsa.Dispose() }
  if ($null -ne $hmac) { $hmac.Dispose() }
  $webhookSecret = $null
  $secretBytes = $null
  $jwt = $null
  $updateBody = $null
}

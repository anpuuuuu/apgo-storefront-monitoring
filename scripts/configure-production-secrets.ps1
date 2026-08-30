param(
  [string]$CentralRepository = 'anpuuuuu/apgo-storefront-monitoring'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command 'gh.exe' -ErrorAction SilentlyContinue)) {
  throw 'GitHub CLI (gh.exe) is not installed or is not available in PATH.'
}

& gh.exe auth status --hostname github.com 1>$null 2>$null
if ($LASTEXITCODE -ne 0) {
  throw 'GitHub CLI is not signed in. Run gh auth login before this setup.'
}

function Set-GitHubSecretValue {
  param(
    [Parameter(Mandatory = $true)][string]$SecretName,
    [Parameter(Mandatory = $true)][string]$SecretValue
  )

  $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $processInfo.FileName = 'gh.exe'
  foreach ($argument in @('secret', 'set', $SecretName, '--repo', $CentralRepository)) {
    [void]$processInfo.ArgumentList.Add($argument)
  }
  $processInfo.UseShellExecute = $false
  $processInfo.CreateNoWindow = $true
  $processInfo.RedirectStandardInput = $true
  $processInfo.RedirectStandardOutput = $true
  $processInfo.RedirectStandardError = $true

  $process = [System.Diagnostics.Process]::Start($processInfo)
  $process.StandardInput.Write($SecretValue)
  $process.StandardInput.Close()
  [void]$process.StandardOutput.ReadToEnd()
  $standardError = $process.StandardError.ReadToEnd()
  $process.WaitForExit()

  if ($process.ExitCode -ne 0) {
    throw "Unable to set $SecretName`: $standardError"
  }
}

function Invoke-TelegramApi {
  param(
    [Parameter(Mandatory = $true)][string]$BotToken,
    [Parameter(Mandatory = $true)][string]$Method,
    [hashtable]$Query = @{}
  )

  $queryString = if ($Query.Count -gt 0) {
    '?' + (($Query.GetEnumerator() | ForEach-Object {
      '{0}={1}' -f [uri]::EscapeDataString([string]$_.Key), [uri]::EscapeDataString([string]$_.Value)
    }) -join '&')
  }
  else {
    ''
  }

  try {
    Invoke-RestMethod -Uri "https://api.telegram.org/bot$BotToken/$Method$queryString"
  }
  catch {
    throw "Telegram API request failed during $Method. The credential was not printed."
  }
}

Write-Host ''
Write-Host 'APGO central monitoring secure setup' -ForegroundColor Cyan
Write-Host 'Inputs are hidden and will not be printed.' -ForegroundColor DarkGray
Write-Host 'Only paste a credential after a numbered prompt appears below. Never paste it at a normal PS> prompt.' -ForegroundColor Yellow
Write-Host ''

$cloudflareToken = $null
$cloudflarePointer = [IntPtr]::Zero
try {
  $cloudflareSecure = Read-Host '1/3 Paste the Cloudflare API Token, then press Enter' -AsSecureString
  $cloudflarePointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($cloudflareSecure)
  $cloudflareToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($cloudflarePointer)

  $cloudflareResult = Invoke-RestMethod `
    -Uri 'https://api.cloudflare.com/client/v4/user/tokens/verify' `
    -Headers @{ Authorization = "Bearer $cloudflareToken" }
  if (-not $cloudflareResult.success -or $cloudflareResult.result.status -ne 'active') {
    throw 'Cloudflare rejected the token.'
  }

  Set-GitHubSecretValue -SecretName 'CF_API_TOKEN' -SecretValue $cloudflareToken
  Write-Host 'Cloudflare token verified and stored in GitHub.' -ForegroundColor Green
}
finally {
  if ($cloudflarePointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($cloudflarePointer)
  }
  $cloudflareToken = $null
  if ($cloudflareSecure) {
    $cloudflareSecure.Dispose()
  }
}

$telegramToken = $null
$telegramPointer = [IntPtr]::Zero
try {
  $telegramSecure = Read-Host '2/3 Paste the Telegram Bot Token, then press Enter' -AsSecureString
  $telegramPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($telegramSecure)
  $telegramToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($telegramPointer)
  $botIdentity = Invoke-TelegramApi -BotToken $telegramToken -Method 'getMe'
  if (-not $botIdentity.ok) {
    throw 'Telegram rejected the Bot Token.'
  }
  Write-Host "Telegram bot verified: @$($botIdentity.result.username)" -ForegroundColor Green

  Write-Host 'In the target Telegram group, send this command now: /monitor_setup' -ForegroundColor Yellow
  [void](Read-Host 'After sending it, press Enter here')
  $updates = Invoke-TelegramApi -BotToken $telegramToken -Method 'getUpdates' -Query @{ limit = 100; timeout = 0 }
  $candidateChats = @(
    $updates.result |
      ForEach-Object {
        if ($_.message.chat) { $_.message.chat }
        elseif ($_.channel_post.chat) { $_.channel_post.chat }
      } |
      Where-Object { $_ -and ($_.type -in @('group', 'supergroup', 'channel')) } |
      Sort-Object id -Unique
  )

  if ($candidateChats.Count -eq 0) {
    throw 'No group update found. Send /monitor_setup in the target group and rerun this setup.'
  }

  Write-Host 'Recent Telegram groups:' -ForegroundColor Cyan
  foreach ($candidateChat in $candidateChats) {
    Write-Host "  $($candidateChat.id)  $($candidateChat.title)  [$($candidateChat.type)]"
  }

  $telegramChatId = Read-Host '3/3 Type the exact Chat ID shown for the monitoring group'
  $selectedChat = $candidateChats |
    Where-Object { [string]$_.id -eq $telegramChatId } |
    Select-Object -First 1
  if (-not $selectedChat) {
    throw 'The Chat ID was not one of the verified recent groups.'
  }

  $chatProbe = Invoke-TelegramApi -BotToken $telegramToken -Method 'getChat' -Query @{ chat_id = $telegramChatId }
  if (-not $chatProbe.ok) {
    throw 'Telegram could not verify the selected Chat ID.'
  }

  Set-GitHubSecretValue -SecretName 'TELEGRAM_BOT_TOKEN' -SecretValue $telegramToken
  Set-GitHubSecretValue -SecretName 'TELEGRAM_CHAT_ID' -SecretValue $telegramChatId
  Write-Host "Telegram secrets stored for: $($selectedChat.title)" -ForegroundColor Green
}
finally {
  if ($telegramPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($telegramPointer)
  }
  $telegramToken = $null
  if ($telegramSecure) {
    $telegramSecure.Dispose()
  }
}

Write-Host ''
Write-Host 'Secure setup completed. You can close this terminal.' -ForegroundColor Green
[void](Read-Host 'Press Enter to finish')

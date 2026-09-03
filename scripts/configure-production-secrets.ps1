param(
  [string]$CentralRepository = 'anpuuuuu/apgo-storefront-monitoring',
  [switch]$TelegramOnly
)

$ErrorActionPreference = 'Stop'
$script:setupStage = 'GitHub authentication'
$script:setupFailureHint = 'Check the setup stage below; saved secrets are kept.'

trap {
  # Never display raw exceptions: API errors can contain credential-bearing URLs.
  Write-Host ''
  Write-Host "SETUP STOPPED: $script:setupStage" -ForegroundColor Red
  Write-Host $script:setupFailureHint -ForegroundColor Yellow
  Write-Host 'Tell Codex the stage and hint above. Do not share any token.'
  [void](Read-Host 'Press Enter to close this window')
  exit 1
}

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

  $script:setupStage = "Save GitHub secret: $SecretName"
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

  $script:setupStage = "Telegram API: $Method"
  try {
    Invoke-RestMethod -Uri "https://api.telegram.org/bot$BotToken/$Method$queryString"
  }
  catch {
    $responseStatus = $_.Exception.Response.StatusCode
    $script:setupFailureHint = if ($responseStatus) {
      "Telegram returned HTTP $([int]$responseStatus) during $Method."
    } else {
      "Telegram request failed during $Method (network or client error)."
    }
    throw "Telegram API request failed during $Method. The credential was not printed."
  }
}

function Find-TelegramSetupChats {
  param($Updates, [string]$Command, [long]$Since)
  $Updates.result | ForEach-Object {
    $message = if ($_.message) { $_.message } else { $_.channel_post }
    if ($message -and -not $message.from.is_bot -and
        [long]$message.date -ge $Since -and
        ([string]$message.text).Trim() -ceq $Command -and
        $message.chat.type -in @('group', 'supergroup', 'channel')) {
      $message.chat
    }
  } | Sort-Object id -Unique
}

Write-Host ''
Write-Host 'APGO central monitoring secure setup' -ForegroundColor Cyan
Write-Host 'Inputs are hidden and will not be printed.' -ForegroundColor DarkGray
Write-Host 'Only paste a credential after a numbered prompt appears below. Never paste it at a normal PS> prompt.' -ForegroundColor Yellow
Write-Host ''

$cloudflareToken = $null
$cloudflarePointer = [IntPtr]::Zero
if (-not $TelegramOnly) {
try {
  $script:setupStage = 'Cloudflare token verification'
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
} else {
  Write-Host 'Resuming Telegram only. Existing Cloudflare secret will not be changed.' -ForegroundColor Cyan
}

$telegramToken = $null
$telegramPointer = [IntPtr]::Zero
try {
  $script:setupStage = 'Telegram token input'
  $telegramSecure = Read-Host '2/3 Paste the Telegram Bot Token, then press Enter' -AsSecureString
  $telegramPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($telegramSecure)
  $telegramToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($telegramPointer)
  $botIdentity = Invoke-TelegramApi -BotToken $telegramToken -Method 'getMe'
  if (-not $botIdentity.ok) {
    throw 'Telegram rejected the Bot Token.'
  }
  Write-Host "Telegram bot verified: @$($botIdentity.result.username)" -ForegroundColor Green

  $setupCommand = "/monitor_setup@$($botIdentity.result.username)"
  $setupSince = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - 60
  do {
    $script:setupStage = 'Waiting for monitoring group command'
    Write-Host 'Check that the verified bot above is your existing monitoring bot and is in the target group.' -ForegroundColor Yellow
    Write-Host "Send this exact command as a NEW message in that group: $setupCommand" -ForegroundColor Cyan
    Write-Host 'Do not send it to BotFather, in a private chat, or as a reply to another bot.'
    $choice = Read-Host 'After sending it, press Enter to check (Q to cancel)'
    if ($choice -ieq 'Q') {
      $script:setupFailureHint = 'Cancelled. Existing GitHub secrets were not changed by the Telegram step.'
      throw 'Setup cancelled.'
    }
    # No offset/allowed_updates changes: do not acknowledge or reconfigure another bot consumer.
    $updates = Invoke-TelegramApi -BotToken $telegramToken -Method 'getUpdates' -Query @{ limit = 100; timeout = 0 }
    if (-not $updates.ok) { throw 'Telegram could not retrieve updates.' }
    $candidateChats = @(Find-TelegramSetupChats -Updates $updates -Command $setupCommand -Since $setupSince)
    if ($candidateChats.Count -eq 0) {
      Write-Host 'No matching group command yet. The token is valid; it remains in memory for this retry.' -ForegroundColor Yellow
      Write-Host 'Check the bot username and group membership, send the full command, then press Enter again.'
    }
  } while ($candidateChats.Count -eq 0)

  Write-Host 'Recent Telegram groups:' -ForegroundColor Cyan
  foreach ($candidateChat in $candidateChats) {
    Write-Host "  $($candidateChat.id)  $($candidateChat.title)  [$($candidateChat.type)]"
  }

  $script:setupStage = 'Telegram group selection'
  $telegramChatId = Read-Host '3/3 Type the exact Chat ID shown for the monitoring group'
  $selectedChat = $candidateChats |
    Where-Object { [string]$_.id -eq $telegramChatId } |
    Select-Object -First 1
  if (-not $selectedChat) {
    $script:setupFailureHint = 'Enter the exact Chat ID from the displayed list, including its minus sign.'
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

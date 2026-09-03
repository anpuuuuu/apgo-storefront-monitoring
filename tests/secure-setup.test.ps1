$ErrorActionPreference = 'Stop'
$setupFile = Join-Path $PSScriptRoot '../scripts/configure-production-secrets.ps1'
$parseTokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($setupFile, [ref]$parseTokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Setup script has syntax errors.' }
$functionAst = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Find-TelegramSetupChats' }, $true)
. ([scriptblock]::Create($functionAst.Extent.Text))
$command = '/monitor_setup@example_bot'
function New-Update($id, $text, $date = 100, $type = 'supergroup', $fromBot = $false) {
  @{ message = @{ text = $text; date = $date; from = @{ is_bot = $fromBot }; chat = @{ id = $id; type = $type; title = 'Test group' } } }
}
$rows = @(
  (New-Update -10 $command),
  (New-Update -10 $command),
  (New-Update -11 'unrelated group message'),
  (New-Update -12 '/monitor_setup@other_bot'),
  (New-Update -13 $command 10),
  (New-Update 14 $command 100 'private'),
  (New-Update -15 $command 100 'supergroup' $true)
)
$chats = @(Find-TelegramSetupChats -Updates @{ result = $rows } -Command $command -Since 50)
if ($chats.Count -ne 1 -or $chats[0].id -ne -10) { throw 'Group selection did not reject unrelated, old, private or bot-generated updates.' }
$empty = @(Find-TelegramSetupChats -Updates @{ result = @() } -Command $command -Since 50)
if ($empty.Count -ne 0) { throw 'Empty updates must remain retryable.' }
Write-Host 'PASS: syntax, exact addressed command, fresh group-only selection, deduplication, empty updates'

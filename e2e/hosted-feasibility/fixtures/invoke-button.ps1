param([Parameter(Mandatory=$true)][int]$FixturePid, [Parameter(Mandatory=$true)][string]$WindowTitle)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $FixturePid)
$windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
$window = $null
foreach ($candidate in $windows) { if ($candidate.Current.Name -eq $WindowTitle) { $window = $candidate; break } }
if ($null -eq $window) { throw "No UIAutomation window for exact PID $FixturePid and title $WindowTitle" }
$buttonCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Save marker')
$button = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
if ($null -eq $button) { throw 'Save marker button not exposed to UIAutomation' }
$invoke = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
$invoke.Invoke()
Write-Output "UIAutomation InvokePattern invoked PID=$FixturePid title=$WindowTitle"

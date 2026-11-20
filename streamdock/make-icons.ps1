# Genera le icone dei tasti (144x144) in com.cullary.streamdock.sdPlugin\images
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot 'com.cullary.streamdock.sdPlugin\images'
New-Item -ItemType Directory -Force $out | Out-Null

$grey = '#313338'; $blue = '#5865f2'; $red = '#da373c'
# nome = glifo, colore stato 0, [glifo e colore stato 1]
$icons = [ordered]@{
  'plugin' = @([char]::ConvertFromUtf32(0x1F4DE), $blue)
  'mic'    = @([char]::ConvertFromUtf32(0x1F399), $grey, [char]::ConvertFromUtf32(0x1F507), $red)
  'deafen' = @([char]::ConvertFromUtf32(0x1F3A7), $grey, [char]::ConvertFromUtf32(0x1F3A7), $red)
  'cam'    = @([char]::ConvertFromUtf32(0x1F4F7), $grey, [char]::ConvertFromUtf32(0x1F4F7), $blue)
  'screen' = @([char]::ConvertFromUtf32(0x1F5A5), $grey, [char]::ConvertFromUtf32(0x1F5A5), $blue)
  'app'    = @([char]::ConvertFromUtf32(0x1FA9F), $grey, [char]::ConvertFromUtf32(0x1FA9F), $blue)
  'audio'  = @([char]::ConvertFromUtf32(0x1F508), $grey, [char]::ConvertFromUtf32(0x1F508), $blue)
  'chat'   = @([char]::ConvertFromUtf32(0x1F4AC), $grey)
  'leave'  = @([string][char]0x2715, $red)
}

function Draw($file, $glyph, $hex) {
  $bmp = New-Object System.Drawing.Bitmap 144, 144
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.ColorTranslator]::FromHtml($hex))
  $font = New-Object System.Drawing.Font 'Segoe UI Emoji', 54
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
  $g.DrawString($glyph, $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 4, 144, 144), $fmt)
  $bmp.Save((Join-Path $out $file), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

foreach ($name in $icons.Keys) {
  $i = $icons[$name]
  Draw "$name.png" $i[0] $i[1]
  if ($i.Count -gt 2) { Draw "$name-on.png" $i[2] $i[3] }
}
"Icone create in $out"

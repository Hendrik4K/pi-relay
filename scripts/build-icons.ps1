param([string]$ProfileIcon='')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$taskRoot=Split-Path $PSScriptRoot -Parent
$taskAssets=Join-Path $taskRoot 'native\Assets'
New-Item -ItemType Directory -Path $taskAssets -Force | Out-Null
if($ProfileIcon){
    Copy-Item -LiteralPath $ProfileIcon -Destination (Join-Path $taskAssets 'MasterControl.ico') -Force
}
$taskSource=Join-Path $taskRoot 'public\assets\raspberry.png'
$taskImage=[Drawing.Image]::FromFile($taskSource)
$taskFrames=@()
try {
    foreach($taskSize in @(16,24,32,48,64,128,256)){
        $taskBitmap=[Drawing.Bitmap]::new($taskSize,$taskSize)
        $taskGraphics=[Drawing.Graphics]::FromImage($taskBitmap)
        $taskGraphics.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $taskScale=[Math]::Min(($taskSize-2)/$taskImage.Width,($taskSize-2)/$taskImage.Height)
        $taskWidth=[int]($taskImage.Width*$taskScale); $taskHeight=[int]($taskImage.Height*$taskScale)
        $taskGraphics.DrawImage($taskImage,[int](($taskSize-$taskWidth)/2),[int](($taskSize-$taskHeight)/2),$taskWidth,$taskHeight)
        $taskStream=[IO.MemoryStream]::new()
        $taskBitmap.Save($taskStream,[Drawing.Imaging.ImageFormat]::Png)
        $taskFrames+=,[pscustomobject]@{size=$taskSize;bytes=$taskStream.ToArray()}
        $taskStream.Dispose();$taskGraphics.Dispose();$taskBitmap.Dispose()
    }
} finally {$taskImage.Dispose()}
$taskOutput=[IO.File]::Create((Join-Path $taskAssets 'PiRelay.ico'))
$taskWriter=[IO.BinaryWriter]::new($taskOutput)
try {
    $taskWriter.Write([uint16]0);$taskWriter.Write([uint16]1);$taskWriter.Write([uint16]$taskFrames.Count)
    $taskOffset=6+16*$taskFrames.Count
    foreach($taskFrame in $taskFrames){
        $taskDimension=if($taskFrame.size -eq 256){0}else{$taskFrame.size}
        $taskWriter.Write([byte]$taskDimension);$taskWriter.Write([byte]$taskDimension)
        $taskWriter.Write([byte]0);$taskWriter.Write([byte]0);$taskWriter.Write([uint16]1);$taskWriter.Write([uint16]32)
        $taskWriter.Write([uint32]$taskFrame.bytes.Length);$taskWriter.Write([uint32]$taskOffset)
        $taskOffset+=$taskFrame.bytes.Length
    }
    foreach($taskFrame in $taskFrames){$taskWriter.Write([byte[]]$taskFrame.bytes)}
}finally{$taskWriter.Dispose()}
$taskProfile=Join-Path $taskAssets 'MasterControl.ico'
if(Test-Path -LiteralPath $taskProfile){
    $taskIcon=[Drawing.Icon]::new($taskProfile,64,64)
    $taskBitmap=$taskIcon.ToBitmap()
    try{$taskBitmap.Save((Join-Path $taskRoot 'public\assets\key-profile.png'),[Drawing.Imaging.ImageFormat]::Png)}finally{$taskBitmap.Dispose();$taskIcon.Dispose()}
}
Write-Output 'Beeren-App-Icon und lokales Schlüssel-Icon erstellt.'

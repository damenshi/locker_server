# 一键部署脚本
# 用法: .\deploy.ps1 "提交信息"

param(
    [Parameter(Mandatory=$false)]
    [string]$Message = "update"
)

$ErrorActionPreference = "Stop"

Write-Host "🚀 开始部署..." -ForegroundColor Cyan

# 1. 本地提交
Write-Host "`n📦 本地提交..." -ForegroundColor Yellow
git add .
git commit -m "$Message" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "   没有变更需要提交，继续..." -ForegroundColor Gray
} else {
    Write-Host "   提交成功" -ForegroundColor Green
}

# 2. 推送到GitHub
Write-Host "`n📤 推送到GitHub..." -ForegroundColor Yellow
git push
Write-Host "   推送成功" -ForegroundColor Green

# 3. 服务器拉取
Write-Host "`n🖥️  服务器拉取代码..." -ForegroundColor Yellow
ssh ubuntu1@1.116.109.239 "cd ~/workspace/locker && git pull"
if ($LASTEXITCODE -ne 0) {
    Write-Host "   服务器拉取失败" -ForegroundColor Red
    exit 1
}
Write-Host "   拉取成功" -ForegroundColor Green

# 4. 重启服务（如果需要）
Write-Host "`n🔄 重启服务..." -ForegroundColor Yellow
ssh ubuntu1@1.116.109.239 "cd ~/workspace/locker && npm start"
Write-Host "   重启成功" -ForegroundColor Green

Write-Host "`n✅ 部署完成！" -ForegroundColor Green

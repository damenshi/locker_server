#!/bin/bash
# 每29天自动重启 locker-server
# 保存位置: ~/workspace/locker/cron_restart.sh

LOCK_FILE="/tmp/locker_last_restart"
DAYS=29
SECONDS_PER_DAY=86400

now=$(date +%s)

if [ -f "$LOCK_FILE" ]; then
    last_restart=$(cat "$LOCK_FILE")
    diff=$(( (now - last_restart) / SECONDS_PER_DAY ))
    
    if [ "$diff" -ge "$DAYS" ]; then
        echo "[$(date)] 距离上次重启已过 $diff 天，执行重启..."
        cd ~/workspace/locker && pm2 restart locker-server
        echo "$now" > "$LOCK_FILE"
        echo "[$(date)] 重启完成"
    else
        echo "[$(date)] 距离上次重启仅 $diff 天，跳过"
    fi
else
    echo "[$(date)] 首次运行，记录时间..."
    cd ~/workspace/locker && pm2 restart locker-server
    echo "$now" > "$LOCK_FILE"
    echo "[$(date)] 重启完成"
fi

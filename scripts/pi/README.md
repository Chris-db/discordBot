# Pi deploy

`6mans-deploy.timer` runs `deploy.sh` every 15 minutes as `chris`. Install once:

```
sudo cp scripts/pi/6mans-deploy.service scripts/pi/6mans-deploy.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now 6mans-deploy.timer
```

The restart step runs `sudo systemctl restart 6mans`, and a timer has no terminal to type
a password into. Allow exactly that one command without one:

```
echo 'chris ALL=(root) NOPASSWD: /usr/bin/systemctl restart 6mans' | sudo tee /etc/sudoers.d/6mans-deploy >/dev/null
sudo chmod 440 /etc/sudoers.d/6mans-deploy
sudo visudo -cf /etc/sudoers.d/6mans-deploy
```

Without it the deploy still pulls, tests and builds, then opens a `deploy-failed` issue
with these instructions and retries the restart on every tick until it works.

Watch a deploy: `journalctl -u 6mans-deploy -f`. Force one: `sudo systemctl start 6mans-deploy.service`.

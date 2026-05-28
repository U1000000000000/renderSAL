# render-wrapper

One Render free-tier web service that runs all your backend projects via PM2.

## Structure

```
render-wrapper/
├── instacrave/          ← git submodule
├── birddrop/            ← git submodule
├── service3/            ← git submodule
├── service4/            ← git submodule
├── service5/            ← git submodule
├── ecosystem.config.js  ← PM2: which service runs on which internal port
├── proxy.js             ← Express proxy: the single port Render sees
├── start.sh             ← Render's start command
├── package.json
└── update-wrapper.yml   ← copy this into each individual repo's .github/workflows/
```

## One-time setup

### 1. Create this repo and add submodules

```bash
mkdir render-wrapper && cd render-wrapper
git init

git submodule add https://github.com/YOU/instacrave
git submodule add https://github.com/YOU/birddrop
git submodule add https://github.com/YOU/service3
git submodule add https://github.com/YOU/service4
git submodule add https://github.com/YOU/service5

git add .
git commit -m "init wrapper with submodules"
git remote add origin https://github.com/YOU/render-wrapper
git push -u origin main
```

### 2. Edit the 3 files to match your actual entry points

In `ecosystem.config.js` — change `script` to each project's actual entry file  
In `proxy.js` — paths and ports are already set, no change needed unless you rename things  
In `start.sh` — update the `services` array if your folder names differ  

### 3. Deploy on Render

- New Web Service → connect `render-wrapper` repo
- **Build command**: `npm install` (Render runs this once before start)
- **Start command**: `bash start.sh`
- **Instance type**: Free
- Add all your environment variables under the Environment tab

### 4. Set up UptimeRobot (keep-alive)

- Sign up free at https://uptimerobot.com
- New Monitor → HTTP(s)
- URL: `https://your-service.onrender.com/health`
- Interval: every 5 minutes
- Done — service never sleeps

### 5. Set up auto-deploy from individual repos (optional but recommended)

Copy `update-wrapper.yml` into each individual repo at `.github/workflows/update-wrapper.yml`  
Edit `WRAPPER_REPO` and `SUBMODULE_PATH` in each copy  
Add `WRAPPER_REPO_PAT` secret to each individual repo (one GitHub PAT covers all of them)

Now pushing to any individual repo → wrapper auto-updates → Render redeploys.

## Your daily workflow

### With GitHub Action set up (recommended)
```bash
# inside instacrave/ as usual — nothing changes
git add .
git commit -m "your message"
git push origin main
# ↑ this automatically triggers a Render redeploy via the GitHub Action
```

### Without GitHub Action
```bash
# 1. push your individual repo as usual
cd instacrave
git push origin main

# 2. update the wrapper (30 seconds extra)
cd ../render-wrapper
git submodule update --remote instacrave
git add instacrave
git commit -m "update instacrave"
git push
```

## Adding a new project in the future

```bash
# 1. Add submodule
cd render-wrapper
git submodule add https://github.com/YOU/newproject

# 2. Add to ecosystem.config.js
#    { name: "newproject", script: "./newproject/index.js", cwd: "./newproject", env: { PORT: 3006 } }

# 3. Add to proxy.js
#    { path: "/newproject", port: 3006 }

# 4. Add folder name to start.sh services array

# 5. Push wrapper
git add .
git commit -m "add newproject"
git push
# Render redeploys, new project is live at /newproject
```

## URL structure

All your services are reachable at one domain:

```
https://your-service.onrender.com/instacrave/...
https://your-service.onrender.com/birddrop/...
https://your-service.onrender.com/service3/...
```

Health check: `https://your-service.onrender.com/health`

# YouTube Cookies

YouTube may block hosted downloads with auth or bot-detection challenges. Export a Netscape `cookies.txt` file from a browser that is already signed in to YouTube, then configure one of these variables.

## Local

```powershell
.\scripts\import-youtube-cookies.ps1 -CookiesPath "C:\path\to\cookies.txt"
npm start
```

The script stores the value in `.env` as `YOUTUBE_COOKIES`. `.env` is ignored by git.

For local development, you can also point directly at a file:

```env
YOUTUBE_COOKIES_FILE=C:\path\to\cookies.txt
```

## Fly.io

```powershell
fly secrets set YOUTUBE_COOKIES="$(Get-Content -Raw C:\path\to\cookies.txt)"
fly deploy
```

## Railway

Set `YOUTUBE_COOKIES` in the Railway service variables to the full contents of the exported `cookies.txt`, then redeploy.

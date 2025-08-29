import express from "express";
import { execSync, spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { rimraf } from "rimraf";
import simpleGit from "simple-git";
import cors from "cors";
import puppeteer from "puppeteer";
import getPort from "get-port";
import prettier from "prettier";

const app = express();
app.use(cors());
app.use(express.json());

const REPOS_ROOT = "./repos";
const OUT_ROOT = "./out";
const PORT = process.env.PORT || 3000;

async function ssgFromViteReact(repoUrl, routes = ["/"]) {
  const repoName = path.basename(repoUrl, ".git");
  const repoPath = path.join(REPOS_ROOT, repoName);
  const distPath = path.join(repoPath, "dist");
  const outPath = path.join(OUT_ROOT, repoName);

  await fs.mkdir(REPOS_ROOT, { recursive: true });
  await fs.mkdir(OUT_ROOT, { recursive: true });
  rimraf.sync(repoPath);
  rimraf.sync(outPath);

  // Клонирование репозитория
  console.log(`Клонирование ${repoUrl}`);
  await simpleGit().clone(repoUrl, repoPath);

  // Установка зависимостей и сборка
  console.log("Установка зависимостей...");
  execSync("npm install", { cwd: repoPath, stdio: "inherit" });
  console.log("Сборка Vite...");
  execSync("npm run build", { cwd: repoPath, stdio: "inherit" });

  // Запуск vite preview на свободном порту
  const portRange = Array.from({ length: 228 }, (_, i) => 5173 + i);
  const port = await getPort({ port: portRange });
  const previewProc = spawn(
    "npx",
    ["vite", "preview", "--port", port, "--strictPort"],
    {
      cwd: repoPath,
      stdio: "ignore",
      detached: true,
    }
  );
  await new Promise((resolve) => setTimeout(resolve, 2000)); // ждём запуск сервера

  // Создаём папки для ассетов
  const assetTypes = {
    scripts: [".js", ".mjs", ".cjs"],
    css: [".css"],
    images: [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico"],
    fonts: [".woff", ".woff2", ".ttf", ".otf", ".eot"],
  };
  const assetFolders = {
    scripts: "scripts",
    css: "css",
    images: "images",
    fonts: "fonts",
  };
  for (const folder of Object.values(assetFolders)) {
    await fs.mkdir(path.join(outPath, folder), { recursive: true });
  }

  // Рекурсивно копируем ассеты по типу из dist и вложенных папок
  async function copyAssetsRecursive(srcDir) {
    const entries = await fs.readdir(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      if (entry.isDirectory()) {
        await copyAssetsRecursive(srcPath);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        let targetFolder = null;
        for (const [type, exts] of Object.entries(assetTypes)) {
          if (exts.includes(ext)) {
            targetFolder = assetFolders[type];
            break;
          }
        }
        if (targetFolder) {
          const destPath = path.join(outPath, targetFolder, entry.name);
          await fs.cp(srcPath, destPath);
        }
        // Всё остальное не переносим
      }
    }
  }
  await copyAssetsRecursive(distPath);

  // Запуск Puppeteer для всех маршрутов
  const browser = await puppeteer.launch();
  for (const route of routes) {
    const page = await browser.newPage();
    const url = `http://localhost:${port}${route}`;
    await page.goto(url, { waitUntil: "networkidle0" });
    let html = await page.content();
    let fileName =
      route === "/" ? "index.html" : `${route.replace(/^\//, "")}.html`;
    await fs.mkdir(outPath, { recursive: true });

    // Меняем пути к ассетам в html
    // JS
    html = html.replace(/src="([^"]+\.js)"/g, (m, p1) => {
      const file = path.basename(p1);
      return `src="/scripts/${file}"`;
    });
    // CSS
    html = html.replace(/href="([^"]+\.css)"/g, (m, p1) => {
      const file = path.basename(p1);
      return `href="/css/${file}"`;
    });
    // Images
    html = html.replace(
      /src="([^"]+\.(png|jpg|jpeg|gif|svg|webp|ico))"/g,
      (m, p1) => {
        const file = path.basename(p1);
        return `src="/images/${file}"`;
      }
    );
    // Fonts (in CSS)
    html = html.replace(/url\(([^)]+\.(woff2?|ttf|otf|eot))\)/g, (m, p1) => {
      const file = path.basename(p1.replace(/['"]/g, ""));
      return `url(/fonts/${file})`;
    });
    const formattedHtml = await prettier.format(html, { parser: "html" });
    await fs.writeFile(path.join(outPath, fileName), formattedHtml);
    await page.close();
  }
  await browser.close();

  // Останавливаем preview сервер
  process.kill(-previewProc.pid); // завершить сервер (минус для detached)

  return outPath;
}

app.post("/api/ssg", async (req, res) => {
  const { repoUrl, routes } = req.body;
  if (!repoUrl) {
    return res.status(400).json({ error: "repoUrl is required" });
  }
  try {
    const outPath = await ssgFromViteReact(repoUrl, routes || ["/"]);
    res.json({ success: true, outPath });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`SSG server running on http://localhost:${PORT}`);
});

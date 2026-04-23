#!/usr/bin/env node
/**
 * Headless-browser URL fetcher for Brain.
 *
 * Usage: browse-url <url> [--html] [--timeout=<ms>]
 *
 * Renders the page in headless Chromium, waits for network idle, and prints
 * the visible text (or raw HTML with --html). Brain invokes this via Bash
 * when WebFetch returns a near-empty body (classic SPA shell).
 */

import { chromium } from "playwright"

const argv = process.argv.slice(2)
if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
  console.error("usage: browse-url <url> [--html] [--timeout=<ms>]")
  process.exit(2)
}

const url = argv[0]
const wantHtml = argv.includes("--html")
const timeoutArg = argv.find((a) => a.startsWith("--timeout="))
const timeout = timeoutArg ? parseInt(timeoutArg.slice("--timeout=".length), 10) : 20_000

if (!/^https?:\/\//i.test(url)) {
  console.error(`refusing to fetch non-http(s) URL: ${url}`)
  process.exit(2)
}

const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (compatible; KodyBrains/1.0; +https://kody-aguy.vercel.app)",
  })
  const page = await context.newPage()
  await page.goto(url, { waitUntil: "networkidle", timeout })

  if (wantHtml) {
    const html = await page.content()
    process.stdout.write(html)
  } else {
    const title = await page.title()
    const text = await page.evaluate(() => document.body?.innerText ?? "")
    const MAX = 40_000
    const truncated = text.length > MAX ? `${text.slice(0, MAX)}\n…[truncated]` : text
    process.stdout.write(`[title] ${title}\n[url] ${page.url()}\n\n${truncated}\n`)
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`browse-url failed: ${msg}`)
  process.exit(1)
} finally {
  await browser.close()
}

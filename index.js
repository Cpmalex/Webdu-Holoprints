import "dotenv/config";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
} from "discord.js";
import { chromium } from "playwright";

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID, // optional: register commands to one guild (instant) instead of globally
  HOLOPRINT_URL = "https://holoprint-mc.github.io/",
  BLOXELIZER_URL = "https://bloxelizer.com/convert/litematic-to-mcstructure",
} = process.env;

const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // default Discord upload limit
const TIMEOUT_MS = 5 * 60 * 1000;

// ---------- Step 1: .litematic -> .mcstructure (via Bloxelizer in the browser) ----------
// Java/Bedrock translation is lossy: edition-exclusive blocks get closest matches.
async function litematicToMcstructure(dir, inputPath, browser) {
  const page = await browser.newPage({ acceptDownloads: true });
  try {
    page.setDefaultTimeout(TIMEOUT_MS);
    await page.goto(BLOXELIZER_URL, { waitUntil: "domcontentloaded" });

    // The drop zone ("Drop a Minecraft schematic / Browse") wraps a hidden file input.
    await page.locator('input[type="file"]').first().setInputFiles(inputPath);

    // Wait for the preview/export controls to appear after the file is parsed.
    const downloadBtn = page
      .getByRole("button", { name: /download|export/i })
      .first();
    await downloadBtn.waitFor({ state: "visible" });

    // Make sure .mcstructure is the selected output format (the page defaults to it,
    // but pick it explicitly if a selector/option is present).
    const mcsOption = page.getByText(/^\.?mcstructure$/i).first();
    if (await mcsOption.isVisible().catch(() => false)) {
      await mcsOption.click().catch(() => {});
    }

    const downloadPromise = page.waitForEvent("download");
    await downloadBtn.click();
    const download = await downloadPromise;

    const outPath = path.join(dir, "build.mcstructure");
    await download.saveAs(outPath);
    return outPath;
  } catch (err) {
    err.screenshot = await page.screenshot().catch(() => null);
    throw err;
  } finally {
    await page.close();
  }
}

// ---------- Step 3: .mcstructure -> HoloPrint .mcpack (via the web app) ----------
async function mcstructureToHoloprint(dir, mcsPath, packName, browser) {
  const page = await browser.newPage({ acceptDownloads: true });
  try {
    page.setDefaultTimeout(TIMEOUT_MS);
    await page.goto(HOLOPRINT_URL, { waitUntil: "networkidle" });

    // The page has several file inputs (structure, world, old pack, icon, resource pack).
    // Prefer the one that accepts .mcstructure; fall back to the first on the page.
    const structureInput = page.locator('input[type="file"][accept*="mcstructure"]');
    const target = (await structureInput.count()) > 0
      ? structureInput.first()
      : page.locator('input[type="file"]').first();
    await target.setInputFiles(mcsPath);

    // Optional: set the pack name (skipped quietly if the field isn't found).
    try {
      await page.getByLabel(/pack name/i).first().fill(packName, { timeout: 3000 });
    } catch {}

    const downloadPromise = page.waitForEvent("download", { timeout: TIMEOUT_MS });
    await page.getByRole("button", { name: /generate pack/i }).click();
    const download = await downloadPromise;

    const outPath = path.join(dir, `${packName}.mcpack`);
    await download.saveAs(outPath);
    return outPath;
  } catch (err) {
    err.screenshot = await page.screenshot().catch(() => null);
    throw err;
  } finally {
    await page.close();
  }
}

// ---------- Simple queue so only one browser/convert job runs at a time ----------
let queue = Promise.resolve();
const enqueue = (job) => {
  const result = queue.then(job, job);
  queue = result.catch(() => {});
  return result;
};

// ---------- Discord ----------
const command = new SlashCommandBuilder()
  .setName("holoprint")
  .setDescription("Convert a .litematic into a HoloPrint .mcpack")
  .addAttachmentOption((o) =>
    o.setName("file").setDescription("Your .litematic file").setRequired(true)
  );

const rest = new REST().setToken(DISCORD_TOKEN);
await rest.put(
  GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID),
  { body: [command.toJSON()] }
);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", (c) => console.log(`Logged in as ${c.user.tag}`));

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "holoprint") return;

  const attachment = interaction.options.getAttachment("file", true);
  if (!attachment.name.toLowerCase().endsWith(".litematic")) {
    return interaction.reply({ content: "Please attach a `.litematic` file.", ephemeral: true });
  }
  if (attachment.size > MAX_INPUT_BYTES) {
    return interaction.reply({ content: "That file is too large (25 MB max).", ephemeral: true });
  }

  await interaction.deferReply();
  const packName = attachment.name.replace(/\.litematic$/i, "").replace(/[^\w.-]+/g, "_") || "build";

  let dir;
  try {
    const mcpackPath = await enqueue(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "holoprint-"));

      const res = await fetch(attachment.url);
      if (!res.ok) throw new Error(`Couldn't download attachment (${res.status})`);
      const inputPath = path.join(dir, "input.litematic");
      await writeFile(inputPath, Buffer.from(await res.arrayBuffer()));

      const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"], // needed in Docker/Railway containers
      });
      try {
        await interaction.editReply("Converting .litematic → .mcstructure (Bloxelizer)…");
        const mcsPath = await litematicToMcstructure(dir, inputPath, browser);

        await interaction.editReply("Generating HoloPrint pack…");
        return await mcstructureToHoloprint(dir, mcsPath, packName, browser);
      } finally {
        await browser.close();
      }
    });

    const { size } = await stat(mcpackPath);
    if (size > MAX_OUTPUT_BYTES) {
      throw new Error(`Pack is ${(size / 1048576).toFixed(1)} MB, over Discord's upload limit.`);
    }

    const file = new AttachmentBuilder(await readFile(mcpackPath), { name: `${packName}.mcpack` });
    await interaction.editReply({
      content: "Done! Open the .mcpack in Minecraft Bedrock to import it.\n-# Java→Bedrock conversion can be lossy (modded blocks, entities, some states).",
      files: [file],
    });
  } catch (err) {
    console.error(err);
    await interaction.editReply({
      content: `Conversion failed: ${String(err.message || err).slice(0, 500)}`,
      files: err.screenshot ? [new AttachmentBuilder(err.screenshot, { name: "debug.png" })] : [],
    });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

await client.login(DISCORD_TOKEN);

import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const run = promisify(execFile);

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID, // optional: register commands to one guild (instant) instead of globally
  HOLOPRINT_URL = "https://holoprint-mc.github.io/",
  CONVERT_CMD = "structura-convert", // from: pip install 'structura-core[bedrock]'
} = process.env;

const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // default Discord upload limit
const TIMEOUT_MS = 5 * 60 * 1000;

// ---------- Step 1 + 2: .litematic -> .nbt -> .mcstructure ----------
async function litematicToMcstructure(dir, inputPath) {
  const nbtPath = path.join(dir, "build.nbt");
  const mcsPath = path.join(dir, "build.mcstructure");

  // Java/Bedrock translation is lossy: vanilla blocks only, entities dropped.
  await run(CONVERT_CMD, [inputPath, nbtPath], { timeout: TIMEOUT_MS });
  await run(CONVERT_CMD, [nbtPath, mcsPath], { timeout: TIMEOUT_MS });
  return mcsPath;
}

// ---------- Step 3: .mcstructure -> HoloPrint .mcpack (via the web app) ----------
async function mcstructureToHoloprint(dir, mcsPath, packName) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
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
  } finally {
    await browser.close();
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

      await interaction.editReply("Converting .litematic → .mcstructure…");
      const mcsPath = await litematicToMcstructure(dir, inputPath);

      await interaction.editReply("Generating HoloPrint pack…");
      return mcstructureToHoloprint(dir, mcsPath, packName);
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
    await interaction.editReply(`Conversion failed: ${String(err.message || err).slice(0, 500)}`);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

await client.login(DISCORD_TOKEN);

import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  AttachmentBuilder,
} from 'discord.js';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID, // optional: set for instant command registration in one server
  HOLOPRINT_URL = 'http://localhost:8080/', // self-hosted HoloPrint recommended
  FILE_INPUT_SELECTOR = 'input[type=file]',
  MAKE_BUTTON_TEXT = 'make pack', // case-insensitive text of HoloPrint's generate button
  MAX_INPUT_MB = '25',
  MAX_OUTPUT_MB = '10', // Discord upload cap for bots (raise if your server is boosted)
  CONVERT_TIMEOUT_MS = '120000',
} = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in .env');
  process.exit(1);
}

const MB = 1024 * 1024;

// ---------- simple job queue (one conversion at a time) ----------
let chain = Promise.resolve();
function enqueue(task) {
  const run = chain.then(task, task);
  chain = run.catch(() => {});
  return run;
}

// ---------- browser ----------
let browser;
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

async function convertLitematic(inputPath) {
  const b = await getBrowser();
  const context = await b.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  try {
    await page.goto(HOLOPRINT_URL, { waitUntil: 'networkidle' });
    await page.setInputFiles(FILE_INPUT_SELECTOR, inputPath, { timeout: 15000 });

    const button = page.getByRole('button', {
      name: new RegExp(MAKE_BUTTON_TEXT, 'i'),
    });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: Number(CONVERT_TIMEOUT_MS) }),
      button.click(),
    ]);

    const outName = download.suggestedFilename() || 'structure.mcpack';
    const outPath = path.join(path.dirname(inputPath), outName);
    await download.saveAs(outPath);
    return { outPath, outName };
  } catch (err) {
    try {
      err.screenshot = await page.screenshot({ fullPage: true });
      const info = await page.evaluate(() => ({
        title: document.title,
        inputs: document.querySelectorAll('input').length,
        buttons: [...document.querySelectorAll('button')]
          .map((b) => b.innerText.trim())
          .filter(Boolean)
          .slice(0, 15),
      }));
      err.pageInfo = JSON.stringify(info);
    } catch {}
    throw err;
  } finally {
    await context.close();
  }
}

// ---------- discord ----------
const command = new SlashCommandBuilder()
  .setName('holoprint')
  .setDescription('Convert a .litematic file into a HoloPrint .mcpack')
  .addAttachmentOption((o) =>
    o.setName('file').setDescription('Your .litematic file').setRequired(true),
  );

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  const rest = new REST().setToken(DISCORD_TOKEN);
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: [command.toJSON()] });
  console.log(`Logged in as ${client.user.tag}; /holoprint registered.`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'holoprint') return;

  const attachment = interaction.options.getAttachment('file', true);

  if (!attachment.name.toLowerCase().endsWith('.litematic')) {
    return interaction.reply({ content: 'Please upload a `.litematic` file.', ephemeral: true });
  }
  if (attachment.size > Number(MAX_INPUT_MB) * MB) {
    return interaction.reply({ content: `File too large (max ${MAX_INPUT_MB} MB).`, ephemeral: true });
  }

  await interaction.deferReply();
  let tmpDir;

  try {
    const result = await enqueue(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'holoprint-'));
      const safeName = path.basename(attachment.name).replace(/[^\w.\- ]/g, '_');
      const inputPath = path.join(tmpDir, safeName);

      const res = await fetch(attachment.url);
      if (!res.ok) throw new Error(`Could not download attachment (${res.status}).`);
      await fs.writeFile(inputPath, Buffer.from(await res.arrayBuffer()));

      return convertLitematic(inputPath);
    });

    const { size } = await fs.stat(result.outPath);
    if (size > Number(MAX_OUTPUT_MB) * MB) {
      await interaction.editReply(
        `Converted, but the pack is ${(size / MB).toFixed(1)} MB, over Discord's upload limit.`,
      );
    } else {
      await interaction.editReply({
        content: 'Done! Import the pack into Minecraft Bedrock.',
        files: [new AttachmentBuilder(result.outPath, { name: result.outName })],
      });
    }
  } catch (err) {
    console.error(err);
    await interaction.editReply({
      content:
        `Conversion failed: ${err.message?.split('\n')[0] ?? 'unknown error'}` +
        (err.pageInfo ? `\nPage info: ${err.pageInfo.slice(0, 1500)}` : ''),
      files: err.screenshot
        ? [new AttachmentBuilder(err.screenshot, { name: 'page.png' })]
        : [],
    });
  } finally {
    if (tmpDir) fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

process.on('SIGINT', async () => {
  await browser?.close();
  process.exit(0);
});

client.login(DISCORD_TOKEN);

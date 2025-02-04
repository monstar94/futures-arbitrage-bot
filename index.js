require('dotenv').config();
const { Telegraf } = require('telegraf');

const { mapArbitrageToButton } = require('./adapters');
const { ARBITRAGE_TYPE, EXCHANGE_NAME, FUNDING_TYPE, REGEX } = require('./constants');
const { getFundingRates } = require('./exchanges');
const { getTimeString, sleep } = require('./utils');
const { User } = require('./models');
const sequelize = require('./services/database.service');
const requestAuth = require('./middleware/request-auth.middleware');
const { findSpotArbitrage } = require('./spotArbitrage');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.telegram.setMyCommands([
  {
    command: 'spreads',
    description: 'Список спредов',
  },
  {
    command: 'spot_futures',
    description: 'Спот-фьючерс',
  },
  {
    command: 'spot_arbitrage',
    description: 'Арбитражные возможности на споте',
  },
]);

async function parseSpotArbitrage() {
    console.log(`${getTimeString()}: Поиск арбитражных ситуаций на споте...`);
    const opportunities = await findSpotArbitrage();
    console.log(`${getTimeString()}: Найдено ${opportunities.length} арбитражных ситуаций.`);
    return opportunities;
}

bot.command('spot_arbitrage', async (ctx) => {
    ctx.reply('🔎 Поиск арбитражных возможностей на спотовых рынках...');
    const opportunities = await parseSpotArbitrage();
    
    if (opportunities.length === 0) {
        ctx.reply('🚫 Арбитражные возможности не найдены.');
    } else {
        let message = '💰 Найдены арбитражные возможности:\n\n';
        opportunities.forEach(op => {
            message += `🔹 ${op.symbol}:\n` +
                `🔺 ${op.exchangeA}: ${op.priceA}$\n` +
                `🔻 ${op.exchangeB}: ${op.priceB}$\n` +
                `📊 Разница: ${op.percentDiff}\n\n`;
        });
        ctx.reply(message);
    }
});

(async function () {
  try {
    bot.launch();

    await sequelize.authenticate();
    await sequelize.sync();

    const superuser = await requestAuth(process.env.SUPERUSER);

    if (!superuser) {
      await User.create({ username: process.env.SUPERUSER });
    }

    while (true) {
      console.log(`${getTimeString()}: Поиск спредов...`);
      const symbolsData = await parseFundingRatesData();
      findArbitrages(symbolsData);
      
      console.log(`${getTimeString()}: Поиск арбитража на споте по запросу...`);
      
      console.log(`${getTimeString()}: Поиск закончен. Следующая итерация через 10 секунд.`);
      await sleep(10);
    }
  } catch (err) {
    console.log(err);
    await sequelize.close();
  }
})();

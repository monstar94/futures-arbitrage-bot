require('dotenv').config();
const { Telegraf } = require('telegraf');

const { mapArbitrageToButton } = require('./adapters');
const { ARBITRAGE_TYPE, EXCHANGE_NAME, FUNDING_TYPE, REGEX } = require('./constants');
const { getFundingRates } = require('./exchanges');
const { getTimeString, sleep } = require('./utils');
const { User } = require('./models');
const sequelize = require('./services/database.service');
const requestAuth = require('./middleware/request-auth.middleware');

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
]);

let futuresArbitrages = [];
let spotFuturesArbitrages = [];

async function parseFundingRatesData() {
  const symbolsData = {};

  for await (const exchange of Object.keys(EXCHANGE_NAME)) {
    try {
      const fundingRatesData = await getFundingRates(exchange);

      Object.entries(fundingRatesData).forEach(([symbol, data]) => {
        if (symbol.includes('USDT')) {
          if (symbol in symbolsData) {
            symbolsData[symbol].push({ exchange, ...data });
          } else {
            symbolsData[symbol] = [{ exchange, ...data }];
          }
        }
      });
    } catch (err) {
      console.log(`Ошибка обработки данных фандинга. ${err}`);
    }
  }

  return symbolsData;
}

function getArbitrageMessage(arbitrage, type) {
  if (!arbitrage) {
    return 'Спред не найден.';
  }

  const { symbol, buyOption, sellOption, rateSpread, priceSpread, sellPriceDivergence, predictedFundingRateSpread } =
    arbitrage;

  const formattedBuyPredictedFundingRate =
    typeof buyOption.predictedFundingRate === 'string'
      ? buyOption.predictedFundingRate
      : buyOption.predictedFundingRate.toFixed(4);
  const formattedSellPredictedFundingRate =
    typeof sellOption.predictedFundingRate === 'string'
      ? sellOption.predictedFundingRate
      : sellOption.predictedFundingRate.toFixed(4);

  let buyMessage = '';
  if (type === ARBITRAGE_TYPE.FUTURES) {
    buyMessage = `📕Покупка/LONG [${buyOption.markPrice}] на ${
      EXCHANGE_NAME[buyOption.exchange]
    }\nТекущая: ${buyOption.fundingRate.toFixed(4)}% (${
      FUNDING_TYPE[buyOption.exchange]
    })\nПрогнозная: ${formattedBuyPredictedFundingRate}%\nОтклонение ставки: ${arbitrage.buyPriceDivergence.toFixed(
      2
    )}% ${buyOption.fundingRate > arbitrage.buyPriceDivergence ? '⬇️✅' : '⬆️❌'}\n🕐Следующая выплата: ${
      buyOption.nextFundingTime
    } (${buyOption.fundingInterval}ч)\n${buyOption.futuresLink}\n\n`;
  } else if (type === ARBITRAGE_TYPE.SPOT) {
    buyMessage = `📕Покупка/LONG [${buyOption.indexPrice}] на ${EXCHANGE_NAME[buyOption.exchange]}\n${
      buyOption.spotLink
    }\n\n`;
  }

  const sellMessage = `📗Продажа/SHORT [${sellOption.markPrice}] на ${
    EXCHANGE_NAME[sellOption.exchange]
  }\nТекущая: ${sellOption.fundingRate.toFixed(4)}% (${
    FUNDING_TYPE[sellOption.exchange]
  })\nПрогнозная: ${formattedSellPredictedFundingRate}%\nОтклонение ставки: ${sellPriceDivergence.toFixed(2)}% ${
    sellOption.fundingRate > sellPriceDivergence ? '⬇️❌' : '⬆️✅'
  }\n🕐Следующая выплата: ${sellOption.nextFundingTime} (${sellOption.fundingInterval}ч)\n${
    sellOption.futuresLink
  }\n\n`;

  return `Пара: ${symbol}\n\n${buyMessage}${sellMessage}💰Спред:\nТекущий: ${rateSpread.toFixed(
    2
  )}%\nПрогнозный: ${predictedFundingRateSpread.toFixed(2)}%\nКурсовой: ${priceSpread.toFixed(2)}%`;
}

function findArbitrages(symbolsData) {
  const newFuturesArbitrages = [];
  const newSpotFuturesArbitrages = [];

  Object.entries(symbolsData).forEach(([symbol, data]) => {
    data.forEach((buyOption) => {
      data.forEach((sellOption) => {
        const buyFundingRate = buyOption.fundingRate;
        const sellFundingRate = sellOption.fundingRate;
        let rateSpread = 0;

        if (buyFundingRate < 0 && sellFundingRate > 0) {
          rateSpread = buyFundingRate + -sellFundingRate;
        } else if (buyFundingRate > 0 && sellFundingRate < 0) {
          rateSpread = -buyFundingRate + sellFundingRate;
        } else if ((buyFundingRate > 0 && sellFundingRate > 0) || (buyFundingRate < 0 && sellFundingRate < 0)) {
          rateSpread = buyFundingRate - sellFundingRate;
        }

        let buyMarkPrice = buyOption.markPrice;
        let sellMarkPrice = sellOption.markPrice;
        const buyIndexPrice = buyOption.indexPrice;
        const sellIndexPrice = sellOption.indexPrice;

        const buyPriceDivergence = (buyMarkPrice / buyIndexPrice - 1) * 100;
        const sellPriceDivergence = (sellMarkPrice / sellIndexPrice - 1) * 100;

        if (buyOption.multiplier !== sellOption.multiplier) {
          if (buyOption.multiplier !== 1) {
            buyMarkPrice = buyMarkPrice / buyOption.multiplier;
          }

          if (sellOption.multiplier !== 1) {
            sellMarkPrice = sellMarkPrice / sellOption.multiplier;
          }
        }

        const markPriceSpread = (sellMarkPrice / buyMarkPrice - 1) * 100;
        const indexPriceSpread = (sellMarkPrice / buyIndexPrice - 1) * 100;

        const buyPredictedFundingRate =
          typeof buyOption.predictedFundingRate === 'string' ? buyPriceDivergence : buyOption.predictedFundingRate;
        const sellPredictedFundingRate =
          typeof sellOption.predictedFundingRate === 'string' ? sellPriceDivergence : sellOption.predictedFundingRate;

        let predictedFundingRateSpread = !!buyPredictedFundingRate ? buyPredictedFundingRate : sellPredictedFundingRate;

        if (buyPredictedFundingRate < 0 && sellPredictedFundingRate > 0) {
          predictedFundingRateSpread = buyPredictedFundingRate + -sellPredictedFundingRate;
        } else if (buyPredictedFundingRate > 0 && sellPredictedFundingRate < 0) {
          predictedFundingRateSpread = -buyPredictedFundingRate + sellPredictedFundingRate;
        } else if (
          (buyPredictedFundingRate > 0 && sellPredictedFundingRate > 0) ||
          (buyPredictedFundingRate < 0 && sellPredictedFundingRate < 0)
        ) {
          predictedFundingRateSpread = buyPredictedFundingRate - sellPredictedFundingRate;
        }

        if (buyOption.exchange !== sellOption.exchange) {
          newFuturesArbitrages.push({
            id: `${symbol}-${buyOption.exchange}-${sellOption.exchange}`,
            symbol,
            buyOption,
            sellOption,
            rateSpread: Math.abs(rateSpread),
            priceSpread: markPriceSpread,
            buyPriceDivergence,
            sellPriceDivergence,
            buyPredictedFundingRate,
            sellPredictedFundingRate,
            predictedFundingRateSpread: Math.abs(predictedFundingRateSpread),
          });
        }

        newSpotFuturesArbitrages.push({
          id: `${symbol}-${buyOption.exchange}-${sellOption.exchange}`,
          symbol,
          buyOption,
          sellOption,
          rateSpread: sellFundingRate,
          priceSpread: indexPriceSpread,
          sellPriceDivergence,
          predictedFundingRateSpread: sellPredictedFundingRate,
        });
      });
    });
  });

  futuresArbitrages = newFuturesArbitrages.sort((a, b) => b.rateSpread - a.rateSpread);
  spotFuturesArbitrages = newSpotFuturesArbitrages.sort((a, b) => b.rateSpread - a.rateSpread);
}

bot.command('spreads', async (ctx) => {
  const user = await requestAuth(ctx.chat.username);

  if (user) {
    const arbitrages = futuresArbitrages.filter(
      (futuresArbitrage) =>
        futuresArbitrage.rateSpread >= user.min_spread &&
        futuresArbitrage.buyOption.fundingRate < futuresArbitrage.sellOption.fundingRate &&
        (futuresArbitrage.priceSpread >= -futuresArbitrage.rateSpread ||
          futuresArbitrage.buyOption.fundingInterval !== 8 ||
          futuresArbitrage.sellOption.fundingInterval !== 8)
    );

    ctx.reply(arbitrages.length ? 'Спреды фьчерсов:' : 'Спреды фьчерсов не найдены.', {
      reply_markup: {
        inline_keyboard: arbitrages.map((arbitrage) => [mapArbitrageToButton(arbitrage, ARBITRAGE_TYPE.FUTURES)]),
      },
    });
  } else {
    ctx.reply('Доступа к боту нет.');
  }
});

bot.command('spot_futures', async (ctx) => {
  const user = await requestAuth(ctx.chat.username);

  if (user) {
    const arbitrages = spotFuturesArbitrages.filter(
      (spotFuturesArbitrage) =>
        spotFuturesArbitrage.rateSpread >= user.min_spread &&
        (spotFuturesArbitrage.priceSpread >= -spotFuturesArbitrage.rateSpread ||
          spotFuturesArbitrage.sellOption.fundingInterval !== 8)
    );

    ctx.reply(arbitrages.length ? 'Спреды спот-фьчерсов:' : 'Спреды спот-фьчерсов не найдены.', {
      reply_markup: {
        inline_keyboard: arbitrages.map((arbitrage) => [mapArbitrageToButton(arbitrage, ARBITRAGE_TYPE.SPOT)]),
      },
    });
  } else {
    ctx.reply('Доступа к боту нет.');
  }
});

bot.action(REGEX.SPREAD, (ctx) => {
  const id = ctx.match[0].split('-').slice(1).join('-');
  const type = ctx.match[0].split('-')[0];
  const arbitrage =
    type === ARBITRAGE_TYPE.FUTURES
      ? futuresArbitrages.find((futuresArbitrage) => futuresArbitrage.id === id)
      : spotFuturesArbitrages.find((spotFuturesArbitrage) => spotFuturesArbitrage.id === id);

  ctx.reply(getArbitrageMessage(arbitrage, type), {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: 'Обновить',
            callback_data: `refresh-${ctx.match[0]}`,
          },
        ],
      ],
    },
    disable_web_page_preview: true,
  });
});

bot.action(REGEX.REFRESH_SPREAD, (ctx) => {
  const id = ctx.match[0].split('-').slice(2).join('-');
  const type = ctx.match[0].split('-')[1];
  const arbitrage =
    type === ARBITRAGE_TYPE.FUTURES
      ? futuresArbitrages.find((futuresArbitrage) => futuresArbitrage.id === id)
      : spotFuturesArbitrages.find((spotFuturesArbitrage) => spotFuturesArbitrage.id === id);
  const arbitrageMessage = getArbitrageMessage(arbitrage, type);

  if (arbitrageMessage !== ctx.callbackQuery.message.text) {
    ctx.editMessageText(arbitrageMessage, {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Обновить',
              callback_data: ctx.match[0],
            },
          ],
        ],
      },
      disable_web_page_preview: true,
    });
  }
});

bot.on('message', async (ctx) => {
  const user = await requestAuth(ctx.chat.username);

  if (user) {
    ctx.reply('Неверная команда.');
  } else {
    ctx.reply('Доступа к боту нет.');
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
      console.log(`${getTimeString()}: Поиск закончен. Следующая итерация через 10 секунд.`);
      await sleep(10);
    }
  } catch (err) {
    console.log(err);
    await sequelize.close();
  }
})();
const { Telegraf } = require('telegraf');
const { findSpotArbitrage } = require('./spotArbitrage');
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.command('spot_arbitrage', async (ctx) => {
    ctx.reply('🔎 Поиск арбитражных возможностей на спотовых рынках...');
    const opportunities = await findSpotArbitrage();
    
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

bot.launch();

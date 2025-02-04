const axios = require('axios');

// Биржи, которые поддерживаются
const exchanges = [
    { name: 'Binance', api: 'https://api.binance.com/api/v3/ticker/price' },
    { name: 'Bybit', api: 'https://api.bybit.com/v2/public/tickers' },
    { name: 'Kucoin', api: 'https://api.kucoin.com/api/v1/market/allTickers' },
    { name: 'Mexc', api: 'https://api.mexc.com/api/v3/ticker/price' }
];

async function getSpotPrices() {
    let prices = {};
    for (let exchange of exchanges) {
        try {
            const response = await axios.get(exchange.api);
            if (exchange.name === 'Binance' || exchange.name === 'Mexc') {
                response.data.forEach(ticker => {
                    if (!prices[ticker.symbol]) prices[ticker.symbol] = {};
                    prices[ticker.symbol][exchange.name] = parseFloat(ticker.price);
                });
            } else if (exchange.name === 'Bybit') {
                response.data.result.forEach(ticker => {
                    if (!prices[ticker.symbol]) prices[ticker.symbol] = {};
                    prices[ticker.symbol][exchange.name] = parseFloat(ticker.last_price);
                });
            } else if (exchange.name === 'Kucoin') {
                response.data.data.ticker.forEach(ticker => {
                    if (!prices[ticker.symbol]) prices[ticker.symbol] = {};
                    prices[ticker.symbol][exchange.name] = parseFloat(ticker.last);
                });
            }
        } catch (error) {
            console.error(`Ошибка при получении данных с ${exchange.name}:`, error.message);
        }
    }
    return prices;
}

async function findSpotArbitrage() {
    const prices = await getSpotPrices();
    let arbitrageOpportunities = [];
    
    Object.keys(prices).forEach(symbol => {
        const exchangesForSymbol = Object.keys(prices[symbol]);
        if (exchangesForSymbol.length > 1) {
            for (let i = 0; i < exchangesForSymbol.length; i++) {
                for (let j = i + 1; j < exchangesForSymbol.length; j++) {
                    let exchangeA = exchangesForSymbol[i];
                    let exchangeB = exchangesForSymbol[j];
                    let priceA = prices[symbol][exchangeA];
                    let priceB = prices[symbol][exchangeB];
                    let diff = Math.abs(priceA - priceB);
                    let percentDiff = (diff / Math.min(priceA, priceB)) * 100;
                    
                    if (percentDiff > 1) {
                        arbitrageOpportunities.push({
                            symbol,
                            exchangeA,
                            exchangeB,
                            priceA,
                            priceB,
                            percentDiff: percentDiff.toFixed(2) + '%'
                        });
                    }
                }
            }
        }
    });
    return arbitrageOpportunities;
}

module.exports = { findSpotArbitrage };

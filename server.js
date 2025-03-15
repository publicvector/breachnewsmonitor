// server.js - Node.js version of the weekly breach monitor
const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');
const natural = require('natural');
const { remove: removeStopwords } = require('stopword');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const winston = require('winston');

// Set up logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} - ${level}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.File({ filename: 'weekly_breach_monitor.log' }),
    new winston.transports.Console()
  ]
});

// Create Express app
const app = express();
app.use(cors());
app.use(express.json());

// Initialize RSS parser
const parser = new Parser();

// Configure Google News RSS feeds
const essential_feeds = {
  "Data Breach": "https://news.google.com/rss/search?q=data+breach&hl=en-US&gl=US&ceid=US:en",
  "Ransomware": "https://news.google.com/rss/search?q=ransomware+attack&hl=en-US&gl=US&ceid=US:en",
  "Data Leak": "https://news.google.com/rss/search?q=data+leak&hl=en-US&gl=US&ceid=US:en",
  "Cybersecurity Incident": "https://news.google.com/rss/search?q=cybersecurity+incident&hl=en-US&gl=US&ceid=US:en"
};

// Initialize natural language processing tools
const tokenizer = new natural.WordTokenizer();
const stemmer = natural.PorterStemmer;

// Cache the news data with an expiration time
let newsCache = {
  data: null,
  timestamp: null,
  expiresIn: 3600000 // 1 hour in milliseconds
};

/**
 * Extract keywords from text
 * @param {string} text - The text to extract keywords from
 * @param {number} topN - Number of top keywords to return
 * @returns {Array} Array of [keyword, frequency] pairs
 */
function extractKeywords(text, topN = 5) {
  if (!text) return [];
  
  // Clean the text
  text = text.replace(/<.*?>/g, ''); // Remove HTML tags
  text = text.replace(/http\S+/g, ''); // Remove URLs
  text = text.replace(/\s+/g, ' ').trim().toLowerCase(); // Clean whitespace and lowercase
  
  // Tokenize
  const tokens = tokenizer.tokenize(text);
  
  // Remove stopwords
  const additionalStops = ['said', 'also', 'would', 'according', 'reported', 'news'];
  const filteredTokens = removeStopwords(tokens).filter(word => {
    return !additionalStops.includes(word) && 
           /^[a-z0-9]+$/.test(word) && // Only keep alphanumeric words
           word.length > 2; // Ignore very short words
  });
  
  // Stem words
  const stemmed = filteredTokens.map(word => stemmer.stem(word));
  
  // Count frequencies
  const wordFreq = {};
  stemmed.forEach(word => {
    wordFreq[word] = (wordFreq[word] || 0) + 1;
  });
  
  // Convert to array of [word, frequency] pairs and sort
  const wordPairs = Object.entries(wordFreq);
  wordPairs.sort((a, b) => b[1] - a[1]);
  
  // Return top N words
  return wordPairs.slice(0, topN);
}

/**
 * Extract source from Google News title format
 * @param {string} title - The title from Google News
 * @returns {Array} [mainTitle, source]
 */
function extractSourceFromTitle(title) {
  if (title.includes(" - ")) {
    const parts = title.split(" - ");
    const source = parts.pop();
    const mainTitle = parts.join(" - ");
    return [mainTitle, source];
  } else {
    return [title, "Unknown"];
  }
}

/**
 * Parse date string to Date object
 * @param {string} dateStr - Date string
 * @returns {Date} Date object
 */
function parseDate(dateStr) {
  try {
    return new Date(dateStr);
  } catch (error) {
    return new Date();
  }
}

/**
 * Fetch articles from Google News
 * @returns {Promise<Array>} Array of article objects
 */
async function fetchGoogleNews() {
  logger.info("Fetching articles from Google News...");
  const articles = [];
  
  // Calculate one week ago for filtering
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  
  // Process each feed
  for (const [searchTerm, url] of Object.entries(essential_feeds)) {
    try {
      logger.info(`Fetching feed for: ${searchTerm}`);
      const feed = await parser.parseURL(url);
      
      if (!feed.items || feed.items.length === 0) {
        logger.warn(`No entries found for ${searchTerm}`);
        continue;
      }
      
      logger.info(`Found ${feed.items.length} entries for ${searchTerm}`);
      
      // Process each entry
      for (const entry of feed.items) {
        try {
          // Get title and source
          const originalTitle = entry.title || "";
          const [cleanTitle, source] = extractSourceFromTitle(originalTitle);
          
          // Get publication date
          const pubDateStr = entry.pubDate || entry.isoDate;
          const pubDateObj = pubDateStr ? parseDate(pubDateStr) : new Date();
          
          // Only include articles from the past week
          if (pubDateObj < oneWeekAgo) {
            continue;
          }
          
          const pubDate = pubDateObj.toISOString().split('T')[0]; // YYYY-MM-DD
          
          // Calculate days/hours ago
          const currentTime = new Date();
          const timeDiff = currentTime - pubDateObj;
          const daysAgo = Math.floor(timeDiff / (1000 * 60 * 60 * 24));
          const hoursAgo = Math.floor(timeDiff / (1000 * 60 * 60));
          
          let timeAgo;
          if (daysAgo > 0) {
            timeAgo = `${daysAgo} day${daysAgo !== 1 ? 's' : ''} ago`;
          } else {
            timeAgo = `${hoursAgo} hour${hoursAgo !== 1 ? 's' : ''} ago`;
          }
          
          // Get summary
          const summary = entry.content || entry.contentSnippet || "";
          
          // Get link
          const link = entry.link || "";
          
          // Extract keywords
          const content = cleanTitle + " " + summary;
          const keywords = extractKeywords(content);
          const keywordsStr = keywords.map(kw => kw[0]).join(", ");
          
          // Add article to list
          articles.push({
            search_term: searchTerm,
            title: cleanTitle,
            pub_date: pubDate,
            time_ago: timeAgo,
            date_obj: pubDateObj, // For sorting
            link,
            source,
            keywords: keywordsStr
          });
        } catch (error) {
          logger.error(`Error processing entry: ${error.message}`);
        }
      }
      
      // Short delay between feeds
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      logger.error(`Error processing feed ${searchTerm}: ${error.message}`);
    }
  }
  
  // Deduplicate articles based on title similarity
  const uniqueArticles = [];
  const seenTitles = new Set();
  
  for (const article of articles) {
    const titleLower = article.title.toLowerCase();
    const isDuplicate = Array.from(seenTitles).some(
      seen => titleLower.includes(seen) || seen.includes(titleLower)
    );
    
    if (!isDuplicate) {
      seenTitles.add(titleLower);
      uniqueArticles.push(article);
    }
  }
  
  // Sort by date (newest first)
  const sortedArticles = uniqueArticles.sort(
    (a, b) => b.date_obj - a.date_obj
  );
  
  logger.info(`Found ${sortedArticles.length} unique articles from the past week`);
  return sortedArticles;
}

/**
 * Generate HTML report from articles
 * @param {Array} articles - Array of article objects
 * @returns {string} HTML string
 */
function generateHtmlReport(articles) {
  if (!articles || articles.length === 0) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Weekly Data Breach News - No Articles Found</title>
          <style>
              body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; }
              h1 { color: #4285F4; }
              .message { background-color: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0; }
          </style>
      </head>
      <body>
          <h1>Weekly Data Breach News</h1>
          <div class="message">
              <h2>No data breach articles found from the past week</h2>
              <p>Try running the script again later, or check your internet connection.</p>
          </div>
      </body>
      </html>
    `;
  }
  
  // Calculate date range for the report title
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 7);
  
  const formatDate = (date) => {
    const options = { month: 'short', day: 'numeric' };
    return date.toLocaleDateString('en-US', options);
  };
  
  const formatFullDate = (date) => {
    const options = { month: 'short', day: 'numeric', year: 'numeric' };
    return date.toLocaleDateString('en-US', options);
  };
  
  const dateRange = `${formatDate(startDate)} - ${formatFullDate(endDate)}`;
  
  let html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Weekly Data Breach News - ${dateRange}</title>
        <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 1200px; margin: 0 auto; padding: 20px; }
            h1 { color: #4285F4; padding-bottom: 10px; border-bottom: 1px solid #eee; }
            .container { overflow-x: auto; }
            table { border-collapse: collapse; width: 100%; margin: 20px 0; }
            th { background-color: #4285F4; color: white; padding: 10px; text-align: left; border: 1px solid #ddd; }
            td { padding: 10px; border: 1px solid #ddd; vertical-align: top; }
            tr:nth-child(even) { background-color: #f9f9f9; }
            tr:hover { background-color: #f1f1f1; }
            a { color: #4285F4; text-decoration: none; }
            a:hover { text-decoration: underline; }
            .keywords { font-style: italic; color: #666; }
            .source { font-weight: bold; color: #d32f2f; }
            .search-term { color: #388e3c; }
            .date { white-space: nowrap; }
            .time-ago { font-size: 0.85em; color: #666; display: block; }
            .footer { margin-top: 30px; padding-top: 15px; border-top: 1px solid #eee; font-size: 0.9em; color: #666; text-align: center; }
        </style>
    </head>
    <body>
        <h1>Weekly Data Breach News</h1>
        <p>Data breach and cybersecurity news from ${dateRange}</p>
        <p>Found ${articles.length} unique articles from the past week.</p>
        
        <div class="container">
            <table>
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Source</th>
                        <th>Title</th>
                        <th>Keywords</th>
                        <th>Search Term</th>
                    </tr>
                </thead>
                <tbody>
  `;
  
  for (const article of articles) {
    html += `
        <tr>
            <td class="date">
                ${article.pub_date}
                <span class="time-ago">${article.time_ago}</span>
            </td>
            <td class="source">${article.source}</td>
            <td><a href="${article.link}" target="_blank">${article.title}</a></td>
            <td class="keywords">${article.keywords}</td>
            <td class="search-term">${article.search_term}</td>
        </tr>
    `;
  }
  
  html += `
                </tbody>
            </table>
        </div>
        
        <div class="footer">
            <p>This weekly report was generated on ${new Date().toISOString().replace('T', ' ').substr(0, 19)}</p>
        </div>
    </body>
    </html>
  `;
  
  return html;
}

// API endpoint for breach news data
app.get('/api/breach-news', async (req, res) => {
  try {
    // Check if cache is valid
    const now = Date.now();
    if (newsCache.data && newsCache.timestamp && (now - newsCache.timestamp < newsCache.expiresIn)) {
      logger.info('Returning cached news data');
      return res.json(newsCache.data);
    }
    
    // Fetch fresh data
    logger.info('Fetching fresh news data');
    const articles = await fetchGoogleNews();
    
    // Create result object
    const result = {
      meta: {
        generated_at: new Date().toISOString(),
        article_count: articles.length,
        sources: [...new Set(articles.map(a => a.source))].length,
        date_range: {
          start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          end: new Date().toISOString().split('T')[0]
        }
      },
      articles: articles
    };
    
    // Update cache
    newsCache.data = result;
    newsCache.timestamp = now;
    
    res.json(result);
  } catch (error) {
    logger.error(`Error in /api/breach-news: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// API endpoint for HTML report
app.get('/report', async (req, res) => {
  try {
    // Get articles (from cache if available)
    let articles;
    const now = Date.now();
    
    if (newsCache.data && newsCache.timestamp && (now - newsCache.timestamp < newsCache.expiresIn)) {
      logger.info('Using cached news data for report');
      articles = newsCache.data.articles;
    } else {
      logger.info('Fetching fresh news data for report');
      articles = await fetchGoogleNews();
      
      // Update cache with the new data
      const result = {
        meta: {
          generated_at: new Date().toISOString(),
          article_count: articles.length,
          sources: [...new Set(articles.map(a => a.source))].length,
          date_range: {
            start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            end: new Date().toISOString().split('T')[0]
          }
        },
        articles: articles
      };
      
      newsCache.data = result;
      newsCache.timestamp = now;
    }
    
    // Generate HTML report
    const html = generateHtmlReport(articles);
    
    // Send HTML response
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    logger.error(`Error in /report: ${error.message}`);
    res.status(500).send(`<h1>Error</h1><p>${error.message}</p>`);
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    cache: {
      exists: !!newsCache.data,
      age: newsCache.timestamp ? Math.floor((Date.now() - newsCache.timestamp) / 1000) + ' seconds' : 'N/A'
    }
  });
});

// Start the server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  logger.info(`Breach news API server running on port ${PORT}`);
  logger.info(`API endpoint: http://localhost:${PORT}/api/breach-news`);
  logger.info(`HTML report: http://localhost:${PORT}/report`);
  logger.info(`Health check: http://localhost:${PORT}/health`);
});

module.exports = app;

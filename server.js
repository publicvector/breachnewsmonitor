const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from the output directory
app.use(express.static('output'));

// Add route to manually run the breach news collection
app.get('/update', async (req, res) => {
  try {
    console.log("Manual update triggered");
    await main();
    res.send('Update completed successfully!');
  } catch (error) {
    res.status(500).send(`Error during update: ${error.message}`);
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`);
});

// Run the data collection on startup
main().catch(console.error);

// Set up a scheduled run every 24 hours
const ONE_DAY = 24 * 60 * 60 * 1000;
setInterval(() => {
  console.log("Running scheduled update...");
  main().catch(console.error);
}, ONE_DAY);

const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Store orders (in-memory for simplicity; use a database in production)
const orders = new Map(); // Map<transactionId, Order>

// DuckFy API credentials (move to environment variables in production)
const DUCKFY_API_BASE_URL = 'https://app.duckfy.com.br/api/v1';
const DUCKFY_PUBLIC_KEY = 'latelieronline01_ge7s6u5s5wi2rvgw';
const DUCKFY_SECRET_KEY = 't4mubgfc587z4kunu28olwlq5qp8xf14j6zmwftd4vw9skjdia2l46hbcj1lscze';

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  try {
    const { event, token, transaction } = req.body;

    // Validate token (replace with your stored token from DuckFy dashboard)
    const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN;
    if (!token || token !== WEBHOOK_TOKEN) {
      return res.status(401).send('Invalid token');
    }

    if (event === 'TRANSACTION_PAID' && transaction.status === 'COMPLETED') {
      const transactionId = transaction.id;
      const order = orders.get(transactionId);
      if (order) {
        // Update order status to processing
        order.status = 'processing';
        orders.set(transactionId, order);

        // Trigger placeOrder for each item
        try {
          const apiOrderIds = await Promise.all(
            order.items.map(async (item) => {
              if (item.service.apiServiceId) {
                const response = await axios.post(
                  `${DUCKFY_API_BASE_URL}/orders`, // Adjust endpoint if needed
                  {
                    serviceId: item.service.apiServiceId,
                    link: item.link,
                    quantity: item.quantity * 1000, // Convert to actual units
                  },
                  {
                    headers: {
                      'x-public-key': DUCKFY_PUBLIC_KEY,
                      'x-secret-key': DUCKFY_SECRET_KEY,
                    },
                  }
                );
                return response.data.order;
              }
              return null;
            })
          );

          // Update order status to completed
          order.status = 'completed';
          order.apiOrderId = apiOrderIds[0] || undefined;
          orders.set(transactionId, order);
          console.log(`Order ${transactionId} completed:`, order);
        } catch (err) {
          console.error(`Failed to place order for ${transactionId}:`, err);
          order.status = 'failed';
          orders.set(transactionId, order);
        }
      }
    }

    res.status(200).send('Webhook received');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Webhook processing failed');
  }
});

// API to update orders (called from frontend)
app.post('/update-order', (req, res) => {
  const { transactionId, order } = req.body;
  orders.set(transactionId, order);
  res.status(200).send('Order updated');
});

// Start server
app.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT}`);
});
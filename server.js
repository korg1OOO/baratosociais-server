const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Node-compatible apiClient (based on api.ts)
const API_KEY = 'db532c749a096ccd762b68e151995624';
const API_URL = process.env.API_URL || 'https://your-api-endpoint.com/api'; // Replace with actual API endpoint

const apiClient = {
  async makeRequest(params) {
    const formData = new FormData();
    formData.append('key', API_KEY);
    Object.entries(params).forEach(([key, value]) => {
      formData.append(key, value.toString());
    });

    try {
      const response = await axios.post(API_URL, formData, {
        headers: formData.getHeaders(),
      });
      if (response.status !== 200) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response.data;
    } catch (error) {
      console.error('API request failed:', error);
      throw error;
    }
  },

  async addOrder(serviceId, link, quantity) {
    return this.makeRequest({
      action: 'add',
      service: serviceId,
      link,
      quantity,
    });
  },
};

// Replicate placeOrder from order.ts
const placeOrder = async (serviceId, link, quantity) => {
  try {
    const response = await apiClient.addOrder(serviceId, link, quantity);
    return response.order;
  } catch (error) {
    console.error('Failed to place order:', error);
    throw new Error('Order placement failed');
  }
};

// Store orders (in-memory for simplicity; use a database in production)
const orders = new Map(); // Map<transactionId, Order>

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  try {
    const { event, token, transaction } = req.body;

    // Validate token
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
                return await placeOrder(item.service.apiServiceId, item.link, item.quantity * 1000); // Convert to actual units
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
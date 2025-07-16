const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies and enable CORS
app.use(express.json());
app.use(cors({
  origin: 'https://baratosociais.vercel.app',
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

// Environment variables
const API_KEY = 'db532c749a096ccd762b68e151995624';
const API_URL = process.env.API_URL || 'https://baratosociais.com/api/v2';
const DUCKFY_API_URL = 'https://app.duckfy.com.br/api/v1';
const DUCKFY_PUBLIC_KEY = process.env.DUCKFY_PUBLIC_KEY;
const DUCKFY_SECRET_KEY = process.env.DUCKFY_SECRET_KEY;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN;

// Validate environment variables
if (!DUCKFY_PUBLIC_KEY || !DUCKFY_SECRET_KEY || !WEBHOOK_TOKEN) {
  console.error('Missing environment variables:', {
    DUCKFY_PUBLIC_KEY: !!DUCKFY_PUBLIC_KEY,
    DUCKFY_SECRET_KEY: !!DUCKFY_SECRET_KEY,
    WEBHOOK_TOKEN: !!WEBHOOK_TOKEN,
  });
  process.exit(1);
}

// Node-compatible apiClient for BaratoSociais API
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
      console.error('BaratoSociais API request failed:', {
        error: error.message,
        response: error.response?.data,
        status: error.response?.status,
      });
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
    console.error('Failed to place order:', {
      serviceId,
      link,
      quantity,
      error: error.message,
      response: error.response?.data,
    });
    throw new Error('Order placement failed');
  }
};

// Store orders (in-memory for simplicity; use a database in production)
const orders = new Map(); // Map<transactionId, Order>

// Endpoint to create Pix payments
app.post('/create-pix', async (req, res) => {
  try {
    const { customer, items } = req.body;

    // Log incoming request
    console.log('Received /create-pix request:', { customer, items });

    // Validate input
    if (!customer || !items || !Array.isArray(items) || !items.length) {
      console.error('Invalid request payload:', { customer, items });
      return res.status(400).json({ error: 'Missing or invalid customer or items' });
    }

    // Validate customer fields
    if (!customer.name || !customer.email || !customer.phone || !customer.socialHandle) {
      console.error('Invalid customer data:', customer);
      return res.status(400).json({ error: 'Missing customer fields', details: customer });
    }

    // Validate items
    for (const item of items) {
      if (!item.service || !item.service.apiServiceId || !item.service.name || !item.service.price || !item.quantity || !item.link) {
        console.error('Invalid item data:', item);
        return res.status(400).json({ error: `Invalid item data for ${item.service?.name || 'unknown'}`, details: item });
      }
    }

    // Create Pix payments for each item
    const pixResponses = await Promise.all(
      items.map(async (item) => {
        try {
          const payload = {
            identifier: `order-${Date.now()}-${item.service.id}`,
            amount: item.service.price * item.quantity, // Price per 1000 units
            client: {
              name: customer.name,
              email: customer.email,
              phone: customer.phone,
              document: customer.socialHandle, // CPF/CNPJ
            },
            products: [
              {
                id: item.service.id,
                name: item.service.name,
                quantity: item.quantity, // In thousands
                price: item.service.price, // Price per 1000 units
              },
            ],
            dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 1 day from now
            metadata: { orderId: `order-${Date.now()}` },
            callbackUrl: 'https://baratosociais-server.onrender.com/webhook',
          };

          console.log('Sending DuckFy API request:', payload);

          const response = await axios.post(
            `${DUCKFY_API_URL}/gateway/pix/receive`,
            payload,
            {
              headers: {
                'x-public-key': DUCKFY_PUBLIC_KEY,
                'x-secret-key': DUCKFY_SECRET_KEY,
              },
            }
          );

          const { transactionId, status, pix } = response.data;
          if (status !== 'OK') {
            throw new Error(`Transaction failed for ${item.service.name}: ${response.data.errorDescription || 'Unknown error'}`);
          }

          // Store order
          const order = {
            id: Date.now().toString() + '-' + item.service.id,
            customer,
            items: [item],
            total: item.service.price * item.quantity,
            status: 'pending',
            createdAt: new Date().toISOString(),
            transactionId,
          };
          orders.set(transactionId, order);

          console.log('Pix created successfully:', { transactionId, pix });

          return { transactionId, pix };
        } catch (err) {
          console.error(`Failed to create Pix for item ${item.service.name}:`, {
            error: err.message,
            response: err.response?.data,
            status: err.response?.status,
          });
          throw err;
        }
      })
    );

    res.status(200).json(pixResponses);
  } catch (err) {
    console.error('Failed to create Pix:', {
      error: err.message,
      response: err.response?.data,
      status: err.response?.status,
    });
    res.status(500).json({ error: 'Failed to create Pix payment', details: err.message });
  }
});

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  try {
    const { event, token, transaction } = req.body;

    // Validate token
    if (!token || token !== WEBHOOK_TOKEN) {
      console.error('Invalid webhook token:', token);
      return res.status(401).json({ error: 'Invalid token' });
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
          console.error(`Failed to place order for ${transactionId}:`, {
            error: err.message,
            response: err.response?.data,
          });
          order.status = 'failed';
          orders.set(transactionId, order);
        }
      } else {
        console.error(`Order not found for transactionId: ${transactionId}`);
      }
    }

    res.status(200).send('Webhook received');
  } catch (err) {
    console.error('Webhook error:', {
      error: err.message,
      response: err.response?.data,
    });
    res.status(500).json({ error: 'Webhook processing failed', details: err.message });
  }
});

// API to update orders (for compatibility, if needed)
app.post('/update-order', (req, res) => {
  const { transactionId, order } = req.body;
  orders.set(transactionId, order);
  res.status(200).send('Order updated');
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('Server is running');
});

// Start server
app.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT}`);
});
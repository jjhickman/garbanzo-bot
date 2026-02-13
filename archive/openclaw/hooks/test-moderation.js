/**
 * Test script for WhatsApp moderation hook
 * 
 * Usage: node test-moderation.js
 */

const { handleInboundMessage } = require('./whatsapp-moderation.js');

// Test messages
const testMessages = [
  {
    name: "Safe message",
    event: {
      channel: 'whatsapp',
      peer: {
        kind: 'group',
        id: 'test-group@g.us',
        name: 'Test Group'
      },
      message: {
        text: "Hey everyone, let's meet up for coffee this weekend!",
        author: {
          id: '+15551234567',
          name: 'Test User'
        }
      }
    }
  },
  {
    name: "Violent message",
    event: {
      channel: 'whatsapp',
      peer: {
        kind: 'group',
        id: 'test-group@g.us',
        name: 'Test Group'
      },
      message: {
        text: "We should organize and attack the government building tomorrow!",
        author: {
          id: '+15559876543',
          name: 'Bad Actor'
        }
      }
    }
  },
  {
    name: "Spam message",
    event: {
      channel: 'whatsapp',
      peer: {
        kind: 'group',
        id: 'test-group@g.us',
        name: 'Test Group'
      },
      message: {
        text: "🎉 CLICK HERE TO WIN $1000000!!! 💰💰💰 Limited time offer!!! Visit bit.ly/scam123",
        author: {
          id: '+15552224444',
          name: 'Spammer'
        }
      }
    }
  },
  {
    name: "Non-WhatsApp message (should be ignored)",
    event: {
      channel: 'telegram',
      peer: {
        kind: 'group',
        id: '123456',
        name: 'Telegram Group'
      },
      message: {
        text: "This should be ignored by the WhatsApp hook",
        author: {
          id: '789',
          name: 'Telegram User'
        }
      }
    }
  }
];

async function runTests() {
  console.log('🧪 Testing WhatsApp Moderation Hook\n');
  console.log('='.repeat(60));
  
  for (const test of testMessages) {
    console.log(`\n📝 Test: ${test.name}`);
    console.log('-'.repeat(60));
    
    try {
      await handleInboundMessage(test.event, {});
    } catch (error) {
      console.error(`❌ Test failed:`, error.message);
    }
    
    console.log('-'.repeat(60));
  }
  
  console.log('\n✅ All tests completed!');
}

runTests().catch(console.error);

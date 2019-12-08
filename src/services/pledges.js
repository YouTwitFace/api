const crypto = require('crypto');
const axios = require('axios');

const {
  PATREON_ACCESS_TOKEN: accessToken,
  PATREON_CAMPAIGN_ID: campaignId,
  PATREON_WEBHOOK_SECRET: webhookSecret,
} = process.env;

function addPledge(item, pledgesByUserId, rewardIdsByCost) {
  const { attributes: { amount_cents, created_at, }, relationships, } = item;
  const pledge = {
    amount_cents,
    created_at,
    reward_id: relationships.reward ? relationships.reward.data.id : null,
  };
  pledgesByUserId[item.relationships.patron.data.id] = pledge;
  rewardIdsByCost[amount_cents] = rewardIdsByCost[amount_cents] || null;
  if (pledge.reward_id) {
    rewardIdsByCost[amount_cents] = pledge.reward_id;
  }
}

function addReward(item, rewardsById) {
  if (item.relationships && item.relationships.campaign.data.id === campaignId) {
    rewardsById[item.id] = item.attributes.title;
  }
}

function addUser(item, pledgesByUserId, users) {
  const { attributes: { first_name: name, }, id } = item;
  const user = {
    id,
    name,
    pledge: pledgesByUserId[item.id],
  };
  users[id] = user;
}

async function getPledges({
  pledgesByUserId = {},
  rewardsById = {},
  rewardIdsByCost = {},
  users = {},
}) {
  let url = `https://www.patreon.com/api/oauth2/api/campaigns/${campaignId}/pledges?include=patron.null`;
  while (url) {
    // eslint-disable-next-line
    const { data } = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    data.data.forEach((item) => {
      if (item.type === 'pledge' && item.attributes.declined_since === null) {
        addPledge(item, pledgesByUserId, rewardIdsByCost);
      }
    });
    data.included.forEach((item) => {
      if (item.type === 'reward') {
        addReward(item, rewardsById);
      } else if (item.type === 'user' && pledgesByUserId[item.id]) {
        addUser(item, pledgesByUserId, users);
      }
    });
    url = data.links.next;
  }

  Object.values(users).forEach((user) => {
    user.pledge.reward_id = user.pledge.reward_id || rewardIdsByCost[user.pledge.amount_cents];
  });

  return {
    pledgesByUserId,
    rewardsById,
    rewardIdsByCost,
    users,
  };
}

function verifySecret(body, signature) {
  try {
    const hash = crypto.createHmac('md5', webhookSecret).update(body).digest('hex');
    return signature === hash;
  } catch (error) {
    console.error(error);
    throw error;
  }
}

class PledgeService {
  constructor() {
    this.data = null;
  }

  async find(params) {
    this.data = this.data || await getPledges({});
    const result = {
      users: Object.values(this.data.users),
      rewards: this.data.rewardsById,
    };
    const { sort } = params.query;
    result.users = result.users.sort((a, b) => {
      if (sort === 'amount') {
        const priceDiff = b.pledge.amount_cents - a.pledge.amount_cents;
        if (priceDiff !== 0) return priceDiff;
      }
      return new Date(a.pledge.created_at) - new Date(b.pledge.created_at);
    });
    return result;
  }

  async create(body, params) {
    if (!verifySecret(params.rawBody, params.headers['x-patreon-signature'])) throw new Error('Invalid signature.');
    const { data, included } = body;
    if (params.headers['x-patreon-event'] === 'pledges:delete') {
      delete this.data.users[data.relationships.patron.data.id];
      delete this.data.pledgesByUserId[data.relationships.patron.data.id];
      return 'OK';
    }
    addPledge(data, this.data.pledgesByUserId, this.data.rewardIdsByCost);
    included.forEach((item) => {
      if (item.type === 'reward') {
        addReward(item, this.data.rewardsById);
      } else if (item.type === 'user' && this.data.pledgesByUserId[item.id]) {
        addUser(item, this.data.pledgesByUserId, this.data.users);
      }
    });
    return this.data.users[data.relationships.patron.data.id];
  }
}

module.exports = PledgeService;

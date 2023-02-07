## Vanguard

> A drop in replacement for Discord.JS v14 websocket system. This should not break anything in Discord.JS v14 (v13 is untested)

<p align="center">
    <img src="https://azurlane.netojuu.com/images/thumb/5/50/VanguardMaid.png/800px-VanguardMaid.png"> 
</p>

### Example Usage
> Without extending the original client
```js
import { Client } from 'discord.js';
import { WebsocketProxy } from 'vanguard';

const client = new Client();
client.ws = new WebsocketProxy(client, options);

client.login('token');
```

> Extending the original client
```js
import { Client } from 'discord.js';
import { WebsocketProxy } from 'vanguard';

class Shipgirl extends Client {
    constructor(...args) {
        super(...args);
        this.ws = new WebsocketProxy(this, options);
    }
}

const client = new Shipgirl();
client.login('token');
```

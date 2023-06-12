## Vanguard

> My own port or translation layer of @discordjs/ws to Discord.JS v14

> Note: Some users said it works at Discord.JS v13

<p align="center">
    <img src="https://azurlane.netojuu.com/images/thumb/5/50/VanguardMaid.png/800px-VanguardMaid.png"> 
</p>

### Example Usage
> Without extending the original client
```js
import { Client } from 'discord.js';
import { Inject } from 'vanguard';

const client = new Client();
Inject(client, options);

client.login('token');
```

> Extending the original client
```js
import { Client } from 'discord.js';
import { WebsocketProxy } from 'vanguard';

class Shipgirl extends Client {
    constructor(...args) {
        super(...args);
        Inject(client, options);
    }
}

const client = new Shipgirl();
client.login('token');
```

> If you are using TS, please use (@ts-expect-error: reason why you are doing so) on applying this package. 
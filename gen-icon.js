const fs = require('fs');
// Simple 48x48 PNG icon - blue circle with key emoji
const d = 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAA2ElEQVRoge3YMQ6DMBAF0OH+h6YgEiWKlMJr7F3P/xdAsjQztkFC8R5AktQXgP0BWFJb2T+pD8CSurrU0wcsqS2v9Cz1AWBJbWW/pyEAS2rL+3sagCW15f2eBmBJbXm/ZwuwpLa839MGLAE2f08bsKS2vN/TBiypLe/3tAFLasv7Pe0AS2rL+z0NwJLa8n5PG7CktmafoQcsqa3Z56gHLKmt2eeoByyprdnnqAcsqa3Z56gHWFJbs89RD7CktmafYwhYUlvZ/6sPYEltZb+vIYAltZX9Pl8B+ABBRSk6PHEAAAAASUVORK5CYII=';
fs.writeFileSync(__dirname + '/chrome-extension/icon.png', Buffer.from(d, 'base64'));
console.log('done');

const MOD_ID = 'bg3-dialogue-system';

function log(msg) { console.log(`BG3-DIALOG | ${msg}`); }

// Zentraler Verteiler für alle Events
function dispatchSystemEvent(data) {
    if (game.user.isGM) {
        if (data.type === "choiceMade") BG3DialogueSystem.processChoice(data);
        else if (data.type === "closeObserver") BG3DialogueSystem.endConversation(data.npcId);
        else if (data.type === "updateRelationship") BG3DialogueSystem.updateRelationshipJournal(data.npcId, data.mod, data.tag);
        else if (data.type === "startCombat") BG3DialogueSystem.startCombat(data.npcId, data.speaker);
        else if (data.type === "processVote") BG3DialogueSystem.processVote(data);
        else if (data.type === "requestSkillCheck") BG3DialogueSystem.handleSkillRequest(data);
        else if (data.type === "resolveSkillCheck") BG3DialogueSystem.resolveSkillCheck(data);
        else if (data.type === "syncNodeRequest") BG3DialogueSystem.syncNodeAcrossClients(data);
    } else {
        game.socket.emit(`module.${MOD_ID}`, data);
    }
}

Hooks.once('init', () => {
    game.settings.register(MOD_ID, 'npcFolder', {
        name: "NPC-Ordner Name", scope: "world", config: true, type: String, default: "BG3-Dialogue-NPCs"
    });
    Handlebars.registerHelper('add', (a, b) => Number(a) + Number(b));
});

Hooks.once('ready', async () => {
    if (game.user.isGM) await BG3DialogueSystem.checkAndCreateDefaults();

    game.socket.on(`module.${MOD_ID}`, async data => {
        const windows = Object.values(ui.windows).filter(a => a instanceof BG3DialogueWindow && a.npc.id === data.npcId);
        
        if (data.type === "showDialog") {
            if (game.user.id === data.receiverId || data.broadcast) {
                new BG3DialogueWindow(
                    data.npcId, data.pcId, data.fullTree, data.startNode, false, 
                    data.relScore, data.relTags, data.isInitiator, data.participantIds
                ).render(true);
            }
        } else if (data.type === "syncVotes") {
            windows.forEach(w => { w.votes = data.votes; w.render(true); });
        } else if (data.type === "syncNode") {
            windows.forEach(w => { 
                w.currentNodeKey = data.nextNode; 
                w.votes = {}; 
                w.isSpotlight = false;
                w.showDelegation = false;
                if (data.nextNode) w.render(true); 
                else w.close();
            });
        } else if (data.type === "spotlightRequest" && game.user.id === data.targetUserId) {
            const w = windows.find(win => !win.isObserver);
            if (w) { w.isSpotlight = true; w.spotlightData = data; w.render(true); }
        } else if (data.type === "closeAll") {
            windows.forEach(w => w.close());
        } else if (data.type === "openCombatTab") {
            if (data.userIds.includes(game.user.id)) {
                ui.sidebar.activateTab("combat");
            }
        } else if (game.user.isGM) {
            dispatchSystemEvent(data);
        }
    });
});

Hooks.on('getSceneControlButtons', (controls) => {
    if (!game.user.isGM) return;
    const tokenControl = controls.find(c => c.name === "token");
    if (tokenControl) {
        tokenControl.tools.push({
            name: "start-bg3-conv",
            title: "BG3 Gespräch starten",
            icon: "fas fa-comments",
            onClick: () => BG3DialogueSystem.showSelectionDialog(),
            button: true
        });
    }
});

class BG3DialogueSystem {
    static activeSessions = {};

    static async checkAndCreateDefaults() {
        let parent = game.folders.find(f => f.name === "Gespräche" && f.type === "JournalEntry") || await Folder.create({ name: "Gespräche", type: "JournalEntry" });
        if (!game.folders.find(f => f.name === "Beziehung" && f.folder?.id === parent.id)) await Folder.create({ name: "Beziehung", type: "JournalEntry", folder: parent.id });
        if (!game.folders.find(f => f.name === "Logs" && f.folder?.id === parent.id)) await Folder.create({ name: "Logs", type: "JournalEntry", folder: parent.id });
    }

    static async getOrCreateRelationship(npcName) {
        let relFolder = game.folders.find(f => f.name === "Beziehung" && f.type === "JournalEntry");
        let report = game.journal.find(j => j.name === npcName && j.folder?.id === relFolder?.id);
        if (!report) {
            report = await JournalEntry.create({ name: npcName, folder: relFolder?.id, pages: [{ name: "Status", type: "text", text: { content: "..." } }] });
            await report.setFlag(MOD_ID, "relationshipScore", 0);
            await report.setFlag(MOD_ID, "tags", []);
        }
        return { score: report.getFlag(MOD_ID, "relationshipScore") || 0, tags: report.getFlag(MOD_ID, "tags") || [], report: report };
    }

    static async updateRelationshipJournal(npcId, adjustment = 0, tag = null) {
        const npc = game.actors.get(npcId);
        if(!npc) return;
        const rel = await this.getOrCreateRelationship(npc.name);
        let newScore = (rel.score || 0) + adjustment;
        let newTags = [...rel.tags];
        if (tag && !newTags.includes(tag)) newTags.push(tag);
        
        await rel.report.setFlag(MOD_ID, "relationshipScore", newScore);
        await rel.report.setFlag(MOD_ID, "tags", newTags);
        
        const status = newScore >= 5 ? "Freundlich" : (newScore <= -5 ? "Feindlich" : "Neutral");
        const page = rel.report.pages.contents[0];
        if(page) {
            await page.update({ "text.content": `<h3>Status: ${npc.name}</h3><p>Stimmung: ${newScore} (${status})</p><ul>${newTags.map(t => `<li>${t}</li>`).join("")}</ul>` });
        }
        return { score: newScore, tags: newTags };
    }

    static showSelectionDialog() {
        const folderName = game.settings.get(MOD_ID, 'npcFolder');
        const folder = game.folders.find(f => f.type === "Actor" && f.name === folderName);
        if (!folder) return ui.notifications.error(`Ordner '${folderName}' nicht gefunden.`);
        const npcs = game.actors.filter(a => a.folder?.id === folder.id);
        const players = game.users.filter(u => u.active && !u.isGM && u.character);

        let npcOptions = npcs.map(n => `<option value="${n.id}">${n.name}</option>`).join("");
        let initiatorOptions = players.map(p => `<option value="${p.id}">${p.name} (${p.character.name})</option>`).join("");
        
        // Die Lobby-Checkboxen für die Berater
        let participantCheckboxes = players.map(p => `
            <label style="display: flex; align-items: center; margin-bottom: 5px; cursor: pointer;">
                <input type="checkbox" name="participants" value="${p.id}" checked style="margin-right: 8px;"> 
                ${p.name} (${p.character.name})
            </label>
        `).join("");

        const content = `
            <form>
                <div class="form-group"><label>NSC (Gegenüber):</label><select name="npcId">${npcOptions}</select></div>
                <div class="form-group"><label>Sprecher (Initiator):</label><select name="initiatorId">${initiatorOptions}</select></div>
                <hr>
                <div class="form-group" style="flex-direction: column; align-items: flex-start;">
                    <label style="margin-bottom: 8px; font-weight: bold;">Wer ist bei dem Gespräch anwesend?</label>
                    <div style="background: rgba(0,0,0,0.1); padding: 10px; border-radius: 5px; width: 100%; border: 1px solid #444;">
                        ${participantCheckboxes}
                    </div>
                </div>
            </form>
        `;

        new Dialog({
            title: "BG3 Lobby",
            content: content,
            buttons: {
                start: { 
                    label: "Gespräch Starten", 
                    callback: (html) => {
                        const npcId = html.find('[name="npcId"]').val();
                        const initId = html.find('[name="initiatorId"]').val();
                        const partIds = [];
                        html.find('input[name="participants"]:checked').each(function() {
                            partIds.push($(this).val());
                        });
                        this.initiateDialogue(npcId, initId, partIds);
                    }
                }
            }
        }).render(true);
    }

    static async initiateDialogue(npcId, initiatorUserId, participantIds) {
        // Sicherstellen, dass der Initiator immer in der Teilnehmerliste ist
        if (!participantIds.includes(initiatorUserId)) {
            participantIds.push(initiatorUserId);
        }

        const npc = game.actors.get(npcId);
        const user = game.users.get(initiatorUserId);
        
        let rawContent = npc.system.details.biography.value || "";
        const rawJson = rawContent.replace(/^(<p>|<div>)+/i, '').replace(/(<\/p>|<\/div>)+$/i, '').trim();
        
        try {
            const fullTree = JSON.parse(rawJson);
            const relData = await this.getOrCreateRelationship(npc.name);
            
            // Nur ausgewählte Spieler und der GM werden berücksichtigt
            const activeUsers = game.users.filter(u => participantIds.includes(u.id) || u.isGM);
            
            this.activeSessions[npcId] = { 
                initiatorId: initiatorUserId, 
                participantIds: participantIds,
                pcName: user?.character?.name || user.name, 
                votes: {}, 
                fullTree, 
                currentNodeKey: "startNode",
                history: [`<b>${npc.name}:</b> ${fullTree.startNode.text}`] 
            };

            activeUsers.forEach(u => {
                const isInitiator = u.id === initiatorUserId;
                const pcId = u.character ? u.character.id : null;
                
                if (u.id === game.user.id) {
                    new BG3DialogueWindow(
                        npcId, pcId, fullTree, "startNode", false, 
                        relData.score, relData.tags, isInitiator, participantIds
                    ).render(true);
                } else {
                    game.socket.emit(`module.${MOD_ID}`, { 
                        type: "showDialog", npcId, pcId: pcId, receiverId: u.id, 
                        fullTree, startNode: "startNode", relScore: relData.score, 
                        relTags: relData.tags, isInitiator, participantIds 
                    });
                }
            });
        } catch (e) { ui.notifications.error("JSON fehlerhaft. Überprüfe die NSC-Biografie."); }
    }

    static processVote(data) {
        const session = this.activeSessions[data.npcId];
        if (!session) return;
        session.votes[data.userId] = data.optionIndex;
        game.socket.emit(`module.${MOD_ID}`, { type: "syncVotes", npcId: data.npcId, votes: session.votes });
    }

    static handleSkillRequest(data) {
        const targetUser = game.users.find(u => u.character?.id === data.targetActorId);
        if (!targetUser) return;
        
        if (targetUser.id === game.user.id) {
             ui.notifications.info("Du führst die Probe selbst aus.");
             return;
        }

        game.socket.emit(`module.${MOD_ID}`, { 
            type: "spotlightRequest", npcId: data.npcId, targetUserId: targetUser.id, 
            skill: data.skill, dc: data.dc, optIndex: data.optIndex, finalDC: data.finalDC 
        });
    }

    static resolveSkillCheck(data) {
        const session = this.activeSessions[data.npcId];
        if (!session) return;
        
        const node = session.fullTree[session.currentNodeKey];
        const opt = node.options[data.optIndex];
        const nextKey = data.success ? opt.passNode : opt.failNode;
        
        const resultColor = data.success ? "#4db8ff" : "#ff4d4d";
        const resTxt = `<br><span style="color: ${resultColor}; font-size: 0.85em;">↳ [Delegierter Wurf: ${data.total} (W20: ${data.d20}) vs SG ${data.finalDC} ➔ <b>${data.success ? 'ERFOLG' : 'FEHLSCHLAG'}</b>]</span>`;

        this.syncNodeAcrossClients({ npcId: data.npcId, speaker: data.speaker, text: opt.text + resTxt, nextKey: nextKey });
    }

    static syncNodeAcrossClients(data) {
        const session = this.activeSessions[data.npcId];
        if (!session) return;

        const nextNode = session.fullTree[data.nextKey];
        let systemLog = "";
        
        if (nextNode) {
            if (nextNode.ship_mod) {
                if (nextNode.ship_mod > 0) systemLog += `[Stimmung verbessert: +${nextNode.ship_mod}] `;
                else if (nextNode.ship_mod < 0) systemLog += `[Stimmung verschlechtert: ${nextNode.ship_mod}] `;
            }
            if (nextNode.ship_tag) systemLog += `[Neues Ereignis: "${nextNode.ship_tag}"]`;
        }

        this.processChoice({
            npcId: data.npcId,
            speaker: data.speaker,
            text: data.text,
            systemLog: systemLog,
            nextNodeText: nextNode?.text
        });

        session.currentNodeKey = data.nextKey;
        session.votes = {};
        
        game.socket.emit(`module.${MOD_ID}`, { type: "syncNode", npcId: data.npcId, nextNode: data.nextKey });

        if (!data.nextKey) {
            this.endConversation(data.npcId);
            game.socket.emit(`module.${MOD_ID}`, { type: "closeAll", npcId: data.npcId });
        }
    }

    static async processChoice(data) {
        const session = this.activeSessions[data.npcId];
        if (!session) return;
        session.history.push(`<b>${data.speaker}:</b> ${data.text}`);
        if (data.systemLog) session.history.push(`<span style="color: #8b0000; font-size: 0.9em;"><i>${data.systemLog}</i></span>`);
        if (data.nextNodeText) session.history.push(`<b>${game.actors.get(data.npcId).name}:</b> ${data.nextNodeText}`);

        ChatMessage.create({ speaker: { alias: data.speaker }, content: `<div class="bg3-chat-msg pc-msg"><b>${data.speaker}:</b> ${data.text}</div>` });
        if (data.nextNodeText) ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: game.actors.get(data.npcId) }), content: `<div class="bg3-chat-msg npc-msg"><b>${game.actors.get(data.npcId).name}:</b> ${data.nextNodeText}</div>` });
    }

    static async startCombat(npcId, speaker) {
        const session = this.activeSessions[npcId];
        if (!session) return;

        const npc = game.actors.get(npcId);
        const participantIds = session.participantIds;
        
        // Finde die Actor-IDs aller beteiligten Spieler
        const pcActorIds = participantIds.map(uid => game.users.get(uid)?.character?.id).filter(id => id);

        ChatMessage.create({
            content: `<div style="background: rgba(198, 40, 40, 0.15); border: 2px solid #c62828; padding: 10px; border-radius: 5px; text-align: center; margin-top: 10px;">
                        <h2 style="color: #c62828; margin: 0; font-family: Modesto Condensed, sans-serif;">⚔️ INITIATIVE WÜRFELN!</h2>
                        <p style="margin: 5px 0 0 0; font-size: 1.1em; color: #ddd;"><b>${speaker}</b> und die Gruppe greifen zu den Waffen!</p>
                      </div>`
        });

        if (canvas.scene) {
            // Nur Tokens von NSC und den AUSGEWÄHLTEN Spielern greifen
            const tokens = canvas.tokens.placeables.filter(t => t.actor?.id === npcId || pcActorIds.includes(t.actor?.id));
            
            if (tokens.length > 0) {
                let combat = game.combat || await Combat.create({ scene: canvas.scene.id });
                
                const createData = tokens.filter(t => !t.inCombat).map(t => ({ 
                    tokenId: t.id, sceneId: canvas.scene.id, actorId: t.actor.id, hidden: t.document.hidden 
                }));
                
                if (createData.length) await combat.createEmbeddedDocuments("Combatant", createData);
                
                // Für NSC automatisch würfeln
                const npcCombatants = combat.combatants.filter(c => c.actorId === npcId);
                if (npcCombatants.length) await combat.rollInitiative(npcCombatants.map(c => c.id));
                
                // Combat Tab beim GM öffnen
                ui.sidebar.activateTab("combat");
                
                // Signal an alle beteiligten Spieler feuern, damit ihr Combat-Tab aufpoppt!
                game.socket.emit(`module.${MOD_ID}`, { type: "openCombatTab", userIds: participantIds });
            }
        }
        
        game.socket.emit(`module.${MOD_ID}`, { type: "closeAll", npcId: npcId });
        await this.endConversation(npcId);
    }

    static async endConversation(npcId) {
        const session = this.activeSessions[npcId];
        if (!session) return;
        
        delete this.activeSessions[npcId];
        
        const logTitle = `${game.actors.get(npcId).name} & ${session.pcName}`;
        let logsFolder = game.folders.find(f => f.name === "Logs");
        let logEntry = game.journal.find(j => j.name === logTitle && j.folder?.id === logsFolder?.id);
        const newContent = `<hr><h3>${new Date().toLocaleString()}</h3>` + session.history.map(h => `<p>${h}</p>`).join("");
        
        let permissions = { default: 0 };
        if (session.initiatorId) permissions[session.initiatorId] = 3;

        if (logEntry) {
            let page = logEntry.pages.contents[0];
            await page.update({ "text.content": (page.text.content || "") + newContent });
        } else {
            await JournalEntry.create({ 
                name: logTitle, folder: logsFolder?.id, ownership: permissions, 
                pages: [{ name: "Protokoll", type: "text", text: { content: newContent } }] 
            });
        }
    }
}

class BG3DialogueWindow extends Application {
    constructor(npcId, pcId, fullTree, currentNodeKey, isObserver = false, relScore = 0, relTags = [], isInitiator = false, participantIds = []) {
        super();
        this.npc = game.actors.get(npcId);
        this.pc = pcId ? game.actors.get(pcId) : null;
        this.fullTree = fullTree;
        this.currentNodeKey = currentNodeKey;
        this.isObserver = isObserver;
        this.relScore = relScore;
        this.relTags = relTags;
        this.isInitiator = isInitiator;
        this.participantIds = participantIds; // Die Lobby-Auswahl speichern
        this.votes = {}; 
        this.isSpotlight = false;
        this.showDelegation = false;
        this.pendingOptIndex = null;
        this.insightResults = {};
        this.processedNodes = new Set();
    }

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, { 
            id: "bg3-dialog-ui", template: "modules/bg3-dialogue-system/templates/dialog.html", width: 700, height: "auto"
        });
    }

    async close(options) {
        if (this.isInitiator) dispatchSystemEvent({ type: "closeObserver", npcId: this.npc.id });
        return super.close(options);
    }

    async render(force, options) {
        if (this.isInitiator && force) {
            const node = this.fullTree[this.currentNodeKey];
            if (node && !this.processedNodes.has(this.currentNodeKey)) {
                this.processedNodes.add(this.currentNodeKey);
                if (node.ship_mod) this.relScore += node.ship_mod;
                if (node.ship_tag && !this.relTags.includes(node.ship_tag)) this.relTags.push(node.ship_tag);
                if (node.ship_mod || node.ship_tag) {
                    dispatchSystemEvent({ type: "updateRelationship", npcId: this.npc.id, mod: node.ship_mod || 0, tag: node.ship_tag });
                }
                await this._handleReactiveInsight(node);
            }
        }
        return super.render(force, options);
    }

    async _handleReactiveInsight(node) {
        if (node.reactive_check && this.insightResults[this.currentNodeKey] === undefined) {
            let roll = await new Roll("1d20").evaluate();
            let d20 = roll.total;
            if (d20 === 1 && this._isHalfling()) {
                roll = await new Roll("1d20").evaluate();
                d20 = roll.total;
            }
            const bonus = this.pc ? (this.pc.system.skills[node.reactive_check.skill]?.total || 0) : 0;
            const success = (d20 + bonus) >= (node.reactive_check.dc + this._getDCMod());
            this.insightResults[this.currentNodeKey] = success;
            
            if (success && node.reactive_check.ship_tag) {
                dispatchSystemEvent({ type: "updateRelationship", npcId: this.npc.id, mod: 0, tag: node.reactive_check.ship_tag });
                if (!this.relTags.includes(node.reactive_check.ship_tag)) this.relTags.push(node.reactive_check.ship_tag);
            }
        }
    }

    _getDCMod() { return this.relScore <= -5 ? 5 : (this.relScore < 0 ? 2 : (this.relScore >= 5 ? -5 : (this.relScore > 0 ? -2 : 0))); }

    _isHalfling() {
        if (!this.pc) return false;
        const raceItem = this.pc.items.find(i => i.type === "race");
        const raceStr = raceItem ? raceItem.name.toLowerCase() : (this.pc.system.details.race?.toLowerCase() || "");
        return raceStr.includes("halbling") || raceStr.includes("halfling");
    }

    getData() {
        const node = this.fullTree[this.currentNodeKey];
        const options = (node?.options || []).filter(o => !o.condition_tag || this.relTags.includes(o.condition_tag)).map((o, i) => {
            let txt = o.text;
            if (o.check && this.pc) {
                const bonus = this.pc.system.skills[o.check]?.total || 0;
                txt = txt.replace(/\[(.*?)\]/, `[$1 ${bonus >= 0 ? '+' : ''}${bonus}]`);
            }
            const votersForThis = Object.entries(this.votes)
                .filter(([uid, idx]) => idx === i)
                .map(([uid, idx]) => ({ name: game.users.get(uid)?.name, img: game.users.get(uid)?.character?.img }));
            return { ...o, displayHtml: txt, voters: votersForThis, votedByMe: this.votes[game.user.id] === i };
        });

        let skillLabel = "";
        if (this.isSpotlight && this.spotlightData) {
            skillLabel = CONFIG.DND5E.skills[this.spotlightData.skill]?.label || this.spotlightData.skill.toUpperCase();
        }

        return {
            npcName: this.npc.name, npcImg: this.npc.img, pcImg: this.pc?.img, pcName: this.pc?.name, text: node?.text,
            options, isInitiator: this.isInitiator, isSpotlight: this.isSpotlight, spotlightSkill: skillLabel,
            showDelegation: this.showDelegation, potentialDelegates: this.showDelegation ? this._getPotentialDelegates() : [],
            relationshipStatus: { class: this.relScore >= 5 ? "friendly" : (this.relScore <= -5 ? "hostile" : "neutral") },
            showInsight: this.insightResults[this.currentNodeKey], insightText: node?.reactive_check?.success_text,
            isEndNode: options.length === 0
        };
    }

    _getPotentialDelegates() {
        const node = this.fullTree[this.currentNodeKey];
        const opt = node.options[this.pendingOptIndex];
        // Filtere nur die Spieler, die in der Lobby ausgewählt wurden!
        return game.users.filter(u => this.participantIds.includes(u.id) && u.character).map(u => ({
            id: u.character.id, name: u.character.name, img: u.character.img,
            bonus: u.character.system.skills[opt.check]?.total || 0,
            isMe: u.id === game.user.id
        }));
    }

    activateListeners(html) {
        super.activateListeners(html);

        html.find('.dialog-option').click(async ev => {
            const idx = $(ev.currentTarget).data('index');
            const opt = this.fullTree[this.currentNodeKey].options[idx];

            if (!this.isInitiator) {
                dispatchSystemEvent({ type: "processVote", npcId: this.npc.id, userId: game.user.id, optionIndex: idx });
            } else {
                if (opt.action === "combat") {
                    dispatchSystemEvent({ type: "choiceMade", npcId: this.npc.id, speaker: this.pc?.name || "Gruppe", text: opt.text, systemLog: "[Kampf initiiert]", nextNodeText: null });
                    dispatchSystemEvent({ type: "startCombat", npcId: this.npc.id, speaker: this.pc?.name || "Gruppe" });
                    return;
                }

                if (opt.check) {
                    this.showDelegation = true;
                    this.pendingOptIndex = idx;
                    this.render(true);
                } else {
                    dispatchSystemEvent({ type: "syncNodeRequest", npcId: this.npc.id, speaker: this.pc?.name || "Gruppe", text: opt.text, nextKey: opt.nextNode });
                }
            }
        });

        html.find('.cancel-delegation').click(() => {
            this.showDelegation = false;
            this.render(true);
        });

        html.find('.delegate-btn').click(async ev => {
            const targetActorId = $(ev.currentTarget).data('actor-id');
            const opt = this.fullTree[this.currentNodeKey].options[this.pendingOptIndex];
            const finalDC = opt.dc + this._getDCMod();

            if (targetActorId === this.pc.id) {
                this.showDelegation = false;
                await this._rollForCheck(this.pendingOptIndex, finalDC, this.pc);
            } else {
                dispatchSystemEvent({ 
                    type: "requestSkillCheck", npcId: this.npc.id, targetActorId, 
                    skill: opt.check, dc: opt.dc, optIndex: this.pendingOptIndex, finalDC: finalDC
                });
                this.showDelegation = false;
                this.render(true);
                ui.notifications.info("Anfrage an Mitspieler gesendet...");
            }
        });

        html.find('.spotlight-btn').click(async () => {
            const data = this.spotlightData;
            this.isSpotlight = false;
            this.render(true);
            await this._rollForCheck(data.optIndex, data.finalDC, this.pc, data.skill);
        });

        html.find('.dialog-close-btn').click(ev => {
            if (!this.isInitiator) return;
            dispatchSystemEvent({ type: "syncNodeRequest", npcId: this.npc.id, speaker: this.pc?.name || game.user.name, text: "<i>*Verlässt das Gespräch*</i>", nextKey: null });
        });
    }

    async _rollForCheck(optIndex, finalDC, rollerPc, overrideSkill = null) {
        const opt = this.fullTree[this.currentNodeKey].options[optIndex];
        const skillId = overrideSkill || opt.check;
        
        let roll = await new Roll("1d20").evaluate();
        let d20 = roll.total;
        
        if (d20 === 1 && this._isHalfling()) {
            ui.notifications.info("🍀 Halblingsglück!");
            roll = await new Roll("1d20").evaluate();
            d20 = roll.total;
        }

        const bonus = rollerPc.system.skills[skillId]?.total || 0;
        let total = d20 + bonus;
        const skillLabel = CONFIG.DND5E.skills[skillId]?.label || skillId.toUpperCase();

        await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: rollerPc }), flavor: `Gesprächsprobe: ${skillLabel} (SG ${finalDC})` });

        if (total < finalDC && rollerPc.system.attributes.inspiration) {
            const useInsp = await new Promise(resolve => {
                new Dialog({
                    title: "✨ Inspiration einsetzen?",
                    content: `<p style="text-align: center;">Dein Wurf <b>(${total})</b> war ein <b>Fehlschlag</b> (SG ${finalDC}).<br>Inspiration nutzen?</p>`,
                    buttons: {
                        yes: { label: "Ja", callback: () => resolve(true) },
                        no: { label: "Nein", callback: () => resolve(false) }
                    }, default: "yes"
                }).render(true);
            });

            if (useInsp) {
                await rollerPc.update({"system.attributes.inspiration": false});
                roll = await new Roll("1d20").evaluate();
                d20 = roll.total;
                total = d20 + bonus;
                await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: rollerPc }), flavor: `✨ Inspiration: ${skillLabel} (SG ${finalDC})` });
            }
        }

        const success = total >= finalDC;
        
        dispatchSystemEvent({ 
            type: "resolveSkillCheck", 
            npcId: this.npc.id, 
            optIndex: optIndex, 
            success: success, 
            total: total, 
            d20: d20,
            speaker: rollerPc.name,
            finalDC: finalDC
        });
    }
}
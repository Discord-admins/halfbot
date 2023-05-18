import type { ClientOptions, Interaction } from "discord.js";
import type { BotInfoData } from "../config/info";
import type { BotStyleData } from "../config/style";
import {
    BotCommandDeployment,
    BotCommandInteraction
} from "../entities/command";

import {
    FilePath,
    aFilePath,
    allFilePaths,
    storeFilePathsInFolders
} from "@disqada/pathfinder";
import {
    ApplicationCommandType,
    Client,
    Collection,
    Events,
    GatewayIntentBits
} from "discord.js";
import { config } from "dotenv";
import { BotInfo } from "../config/info";
import { BotStyle } from "../config/style";
import { BotVars } from "../config/vars";
import { BotCommand } from "../entities/command";
import { BotEvent } from "../entities/event";
import interactionCreate from "../events/interactionCreate";
import ready from "../events/ready";
import Importer from "../helpers/classes/importer";
import { Modules, RecordStates } from "../helpers/data/enums";
import { Logger, Record } from "./logger";
config();

export interface DiscordBotData {
    rootDirectory: string;
}

export class DiscordBot {
    public client: Client;
    public vars: BotVars = {};
    public info: BotInfo = { clientId: "" };
    public style?: BotStyle;

    public commands: Collection<string, BotCommand> = new Collection();

    public constructor(
        data: DiscordBotData = {
            rootDirectory: "bot"
        },
        options: ClientOptions = {
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.GuildMembers
            ]
        }
    ) {
        // TODO Check token and clientId validity

        this.client = new Client(options);

        storeFilePathsInFolders([data.rootDirectory], true);

        this.runBot();
    }

    private async runBot() {
        await this.retrieveData<BotInfoData>("info", (data) => {
            this.info = new BotInfo(data);
        });

        await this.retrieveData<object>("vars", (data) => {
            this.vars = new BotVars(data);
        });

        await this.retrieveData<BotStyleData>("style", (data) => {
            this.style = new BotStyle(data);
        });

        await this.registerAllModules();
        this.runCoreEvents();

        await this.client.login(process.env.TOKEN);
    }

    private runCoreEvents() {
        this.client.on(Events.ClientReady, () => ready(this));
        this.client.on(Events.InteractionCreate, (interaction: Interaction) => {
            const botInteraction: BotCommandInteraction =
                interaction as BotCommandInteraction;
            botInteraction.bot = this;
            interactionCreate(botInteraction);
        });
    }

    private async retrieveData<DataType>(
        fileName: string,
        useData: (data: DataType) => void
    ) {
        const filePath = aFilePath(fileName);
        if (filePath && filePath instanceof FilePath) {
            const data = await Importer.importFile<DataType>(filePath.fullPath);
            if (data) {
                useData(data);
            }
        } else {
            throw new Error(`Could not find ${fileName}`);
        }
    }

    private async registerCommand(command: BotCommand) {
        if (command.data.types.chatInput) {
            command.data.type = ApplicationCommandType.ChatInput;
            this.commands.set(command.data.name, command);
        }

        if (command.data.types.contextMenu) {
            // Note: The 2 is ApplicationCommandType.User
            command.data.type = command.data.types.contextMenu + 2;
            this.commands.set(command.data.name, command);
        }
    }

    private async registerEvent(event: BotEvent<any>) {
        this.client.on(event.data.name, (...args: any) =>
            event.execute(this, ...args)
        );
    }

    private async registerAllModules() {
        const filePaths = allFilePaths()?.filter(
            (path) =>
                path.fullPath.includes(Modules.Commands) ||
                path.fullPath.includes(Modules.Events)
        );
        if (!filePaths) {
            return;
        }

        const logger = new Logger();

        for (const filePath of filePaths) {
            const botModule: BotCommand | BotEvent<any> | any | void =
                await Importer.importFile(filePath.fullPath);

            let name;
            if (typeof botModule === "object" && botModule?.data?.name) {
                name = botModule?.data?.name;
            } else {
                const word = "modules";
                const index = filePath.fullPath.indexOf(word);
                name = filePath.fullPath.substring(index + word.length);
            }

            const record: Record = {
                name: name,
                state: RecordStates.Success
            };

            if (botModule instanceof BotCommand) {
                record.type = Modules.Commands;
                record.deployment = botModule.data.deployment;

                if (BotCommand.isValid(botModule)) {
                    this.registerCommand(botModule);
                } else {
                    record.state = RecordStates.Fail;
                    record.message = `The command is invalid, a required property is missing`;
                }
            } else if (botModule instanceof BotEvent) {
                record.type = Modules.Events;
                record.deployment = BotCommandDeployment.Global;

                if (BotEvent.isValid(botModule)) {
                    this.registerEvent(botModule);
                } else {
                    record.state = RecordStates.Fail;
                    record.message = `The module is invalid, a required property is missing`;
                }
            } else {
                record.state = RecordStates.Error;
                record.message = "The file was empty or not exported correctly";
            }

            logger.add(record);
        }

        Logger.debug(logger);
    }
}

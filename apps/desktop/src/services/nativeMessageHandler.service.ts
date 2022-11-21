import { Injectable } from "@angular/core";
import { ipcRenderer } from "electron";
import Swal from "sweetalert2";

import { CryptoService } from "@bitwarden/common/abstractions/crypto.service";
import { CryptoFunctionService } from "@bitwarden/common/abstractions/cryptoFunction.service";
import { I18nService } from "@bitwarden/common/abstractions/i18n.service";
import { MessagingService } from "@bitwarden/common/abstractions/messaging.service";
import { NativeMessagingVersion } from "@bitwarden/common/enums/nativeMessagingVersion";
import { Utils } from "@bitwarden/common/misc/utils";
import { EncString } from "@bitwarden/common/models/domain/enc-string";
import { SymmetricCryptoKey } from "@bitwarden/common/models/domain/symmetric-crypto-key";
import { StateService } from "@bitwarden/common/services/state.service";

import { DecryptedCommandData } from "../models/nativeMessaging/decryptedCommandData";
import { EncryptedMessage } from "../models/nativeMessaging/encryptedMessage";
import { EncryptedMessageResponse } from "../models/nativeMessaging/encryptedMessageResponse";
import { Message } from "../models/nativeMessaging/message";
import { UnencryptedMessage } from "../models/nativeMessaging/unencryptedMessage";
import { UnencryptedMessageResponse } from "../models/nativeMessaging/unencryptedMessageResponse";

import { EncryptedMessageHandlerService } from "./encryptedMessageHandlerService";

const EncryptionAlgorithm = "sha1";

@Injectable()
export class NativeMessageHandlerService {
  private ddgSharedSecret: SymmetricCryptoKey;

  constructor(
    private stateService: StateService,
    private cryptoService: CryptoService,
    private cryptoFunctionService: CryptoFunctionService,
    private messagingService: MessagingService,
    private i18nService: I18nService,
    private encryptedMessageHandlerService: EncryptedMessageHandlerService
  ) {}

  async handleMessage(message: Message) {
    const decryptedCommand = message as UnencryptedMessage;
    if (message.version != NativeMessagingVersion.Latest) {
      this.sendResponse({
        messageId: message.messageId,
        version: NativeMessagingVersion.Latest,
        payload: {
          error: "version-discrepancy",
        },
      });
    } else {
      if (decryptedCommand.command === "bw-handshake") {
        await this.handleDecryptedMessage(decryptedCommand);
      } else {
        await this.handleEncryptedMessage(message as EncryptedMessage);
      }
    }
  }

  private async handleDecryptedMessage(message: UnencryptedMessage) {
    const { messageId, payload } = message;
    const { publicKey, applicationName } = payload;
    if (!publicKey) {
      this.sendResponse({
        messageId: messageId,
        version: NativeMessagingVersion.Latest,
        payload: {
          error: "cannot-decrypt",
        },
      });
      return;
    }

    try {
      const remotePublicKey = Utils.fromB64ToArray(publicKey).buffer;
      const ddgEnabled = await this.stateService.getEnableDuckDuckGoBrowserIntegration();

      if (!ddgEnabled) {
        this.sendResponse({
          messageId: messageId,
          version: NativeMessagingVersion.Latest,
          payload: {
            error: "canceled",
          },
        });

        return;
      }
      // eslint-disable-next-line
      console.log("1: Get confirmation from user");

      // Ask for confirmation from user
      this.messagingService.send("setFocus");
      const submitted = await Swal.fire({
        heightAuto: false,
        titleText: this.i18nService.t("verifyNativeMessagingConnectionTitle", applicationName),
        html: `${this.i18nService.t("verifyNativeMessagingConnectionDesc")}<br>${this.i18nService.t(
          "verifyNativeMessagingConnectionWarning"
        )}`,
        showCancelButton: true,
        cancelButtonText: this.i18nService.t("no"),
        showConfirmButton: true,
        confirmButtonText: this.i18nService.t("yes"),
        allowOutsideClick: false,
        focusCancel: true,
      });

      if (submitted.value !== true) {
        this.sendResponse({
          messageId: messageId,
          version: NativeMessagingVersion.Latest,
          payload: {
            error: "canceled",
          },
        });
        return;
      }
      // eslint-disable-next-line
      console.log("2: Generating secret");
      const secret = await this.cryptoFunctionService.randomBytes(64);
      // eslint-disable-next-line
      console.log("3: Creating symmetric crypto key");
      this.ddgSharedSecret = new SymmetricCryptoKey(secret);
      // eslint-disable-next-line
      console.log("4: Getting b64 string");
      const sharedKeyB64 = new SymmetricCryptoKey(secret).keyB64;

      // eslint-disable-next-line
      console.log("5: Setting key in state service");
      await this.stateService.setDuckDuckGoSharedKey(sharedKeyB64);

      // eslint-disable-next-line
      console.log("6: Encrypting secret");
      const encryptedSecret = await this.cryptoFunctionService.rsaEncrypt(
        secret,
        remotePublicKey,
        EncryptionAlgorithm
      );

      // eslint-disable-next-line
      console.log("7: Sending response");
      this.sendResponse({
        messageId: messageId,
        version: NativeMessagingVersion.Latest,
        payload: {
          status: "success",
          sharedKey: Utils.fromBufferToB64(encryptedSecret),
        },
      });
    } catch (error) {
      // eslint-disable-next-line
      console.log("Something went wrong");
      this.sendResponse({
        messageId: messageId,
        version: NativeMessagingVersion.Latest,
        payload: {
          error: "cannot-decrypt",
        },
      });
    }
  }

  private async handleEncryptedMessage(message: EncryptedMessage) {
    message.encryptedCommand = EncString.fromJSON(message.encryptedCommand.toString());
    const decryptedCommandData = await this.decryptPayload(message);
    const { command } = decryptedCommandData;

    try {
      const responseData = await this.encryptedMessageHandlerService.responseDataForCommand(
        decryptedCommandData
      );

      await this.sendEncryptedResponse(message, { command, payload: responseData });
    } catch (error) {
      this.sendEncryptedResponse(message, { command, payload: {} });
    }
  }

  private async encryptPayload(
    payload: DecryptedCommandData,
    key: SymmetricCryptoKey
  ): Promise<EncString> {
    return await this.cryptoService.encrypt(JSON.stringify(payload), key);
  }

  private async decryptPayload(message: EncryptedMessage): Promise<DecryptedCommandData> {
    if (!this.ddgSharedSecret) {
      const storedKey = await this.stateService.getDuckDuckGoSharedKey();
      if (storedKey == null) {
        this.sendResponse({
          messageId: message.messageId,
          version: NativeMessagingVersion.Latest,
          payload: {
            error: "cannot-decrypt",
          },
        });
        return;
      }
      this.ddgSharedSecret = SymmetricCryptoKey.fromJSON({ keyB64: storedKey });
    }

    try {
      let decryptedResult = await this.cryptoService.decryptToUtf8(
        message.encryptedCommand as EncString,
        this.ddgSharedSecret
      );

      decryptedResult = this.trimNullCharsFromMessage(decryptedResult);

      return JSON.parse(decryptedResult);
    } catch {
      this.sendResponse({
        messageId: message.messageId,
        version: NativeMessagingVersion.Latest,
        payload: {
          error: "cannot-decrypt",
        },
      });
      return;
    }
  }

  private async sendEncryptedResponse(
    originalMessage: EncryptedMessage,
    response: DecryptedCommandData
  ) {
    if (!this.ddgSharedSecret) {
      this.sendResponse({
        messageId: originalMessage.messageId,
        version: NativeMessagingVersion.Latest,
        payload: {
          error: "cannot-decrypt",
        },
      });

      return;
    }

    const encryptedPayload = await this.encryptPayload(response, this.ddgSharedSecret);

    this.sendResponse({
      messageId: originalMessage.messageId,
      version: NativeMessagingVersion.Latest,
      encryptedPayload,
    });
  }

  private sendResponse(response: EncryptedMessageResponse | UnencryptedMessageResponse) {
    ipcRenderer.send("nativeMessagingReply", response);
  }

  // Trim all null bytes padded at the end of messages. This happens with C encryption libraries.
  private trimNullCharsFromMessage(message: string): string {
    const charNull = 0;
    const charRightCurlyBrace = 125;
    const charRightBracket = 93;

    for (let i = message.length - 1; i >= 0; i--) {
      if (message.charCodeAt(i) === charNull) {
        message = message.substring(0, message.length - 1);
      } else if (
        message.charCodeAt(i) === charRightCurlyBrace ||
        message.charCodeAt(i) === charRightBracket
      ) {
        break;
      }
    }
    return message;
  }
}

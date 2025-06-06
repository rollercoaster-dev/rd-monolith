import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/types";

// Define custom types for the SimpleWebAuthn library
// These types extend the official types to include properties that are actually used
// or structured differently at runtime than indicated by the @simplewebauthn/types definitions.
// This is necessary due to discrepancies in the upstream library's typings.
/**
 * Custom interface extending the base RegistrationResponseJSON type from @simplewebauthn/types.
 * This accurately reflects the structure received from the client and expected by certain parts of the verification logic.
 */
export interface ExtendedRegistrationResponseJSON
  extends RegistrationResponseJSON {
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: AuthenticatorTransportFuture[];
  };
}

/**
 * Custom interface extending the base AuthenticationResponseJSON type from @simplewebauthn/types.
 * This accurately reflects the structure received from the client and expected by certain parts of the verification logic.
 */
export interface ExtendedAuthenticationResponseJSON
  extends AuthenticationResponseJSON {
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
}

import { authConfig } from "@backend/config/auth.config";
import { db } from "@backend/db";
import { webauthnCredentials, users } from "@backend/db/schema";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";

// Define our own AuthenticatorDevice type based on what we need for database storage
// and passing to the verification functions. This aligns with the structure
// expected by @simplewebauthn/server verification functions, despite potential
// type mismatches in the library's own definitions.
export interface AuthenticatorDevice {
  credentialID: string;
  credentialPublicKey: Uint8Array;
  counter: number;
  transports?: AuthenticatorTransportFuture[];
}

// Define a custom type for the verification parameters passed to verifyAuthenticationResponse.
// This is necessary because the official types for @simplewebauthn/server's
// verifyAuthenticationResponse may not accurately reflect the expected shape, particularly
// regarding the 'authenticator' property. This interface ensures our internal type safety.
export interface VerifyAuthenticationResponseOpts {
  response: AuthenticationResponseJSON;
  expectedChallenge:
    | string
    | ((challenge: string) => boolean | Promise<boolean>);
  expectedOrigin: string | string[];
  expectedRPID: string;
  authenticator: AuthenticatorDevice;
}

// Define the expected origin based on the environment
const expectedOrigin = authConfig.webauthn.origin;

/**
 * WebAuthn service for handling registration and authentication
 */
export class WebAuthnService {
  /**
   * Generate options for registering a new WebAuthn credential
   * @param userId The user ID
   * @param username The username
   * @param existingDevices Optional array of existing authenticator devices
   * @returns Registration options
   */
  static async generateRegistrationOptions(
    userId: string,
    username: string,
    existingDevices: AuthenticatorDevice[] = [],
  ) {
    console.log(
      `[WebAuthnService] Generating registration options for user: ${userId}`,
    );

    // Convert existing devices to the format expected by generateRegistrationOptions
    const existingCredentials = existingDevices.map((device) => ({
      id: device.credentialID,
      type: "public-key" as const,
      transports: device.transports,
    }));

    // Generate registration options
    const options = await generateRegistrationOptions({
      rpName: authConfig.webauthn.rpName,
      rpID: authConfig.webauthn.rpID,
      userID: Buffer.from(userId),
      userName: username,
      // Don't prompt users for additional information about the authenticator
      attestationType: "none",
      // Prevent users from re-registering existing authenticators
      excludeCredentials: existingCredentials,
      // Support for multiple devices
      authenticatorSelection: {
        // Require resident key (discoverable credential)
        residentKey: "preferred",
        // Encourage users to use authenticators that support user verification
        userVerification: "preferred",
        // Allow both platform and cross-platform authenticators
        authenticatorAttachment: "platform",
      },
    });

    return options;
  }

  /**
   * Verify a WebAuthn registration response
   * @param userId The user ID
   * @param friendlyName Optional friendly name for the credential
   * @param response The registration response from the client
   * @param expectedChallenge The expected challenge string retrieved from the user's session.
   * @returns The verification result, including the credential ID if successful.
   * @remarks
   * This method uses a type assertion (`as unknown as RegistrationInfoWithCredentials`)
   * when handling the `registrationInfo` returned by `verifyRegistrationResponse`.
   * This is a workaround for inaccuracies in the `@simplewebauthn/server` library's return types.
   * The local `RegistrationInfoWithCredentials` interface defines the expected structure based on runtime behavior.
   */
  static async verifyRegistration(
    userId: string,
    friendlyName: string | undefined,
    response: RegistrationResponseJSON,
    expectedChallenge: string,
  ) {
    console.log(`[WebAuthnService] Verifying registration for user: ${userId}`);

    try {
      // Verify the registration response
      // The expectedChallenge parameter takes a callback function that compares the challenge
      // extracted from the clientDataJSON with our stored challenge from the session
      // This is a critical security check to prevent replay attacks
      const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: (clientChallenge) => {
          console.log(
            `[WebAuthnService] Comparing client challenge with expected challenge`,
          );
          console.log(
            `[WebAuthnService] Client challenge: ${clientChallenge.substring(0, 10)}...`,
          );
          console.log(
            `[WebAuthnService] Expected challenge: ${expectedChallenge.substring(0, 10)}...`,
          );
          return clientChallenge === expectedChallenge;
        },
        expectedOrigin,
        expectedRPID: authConfig.webauthn.rpID,
      });

      const { verified, registrationInfo } = verification;

      if (!verified || !registrationInfo) {
        console.warn(
          `[WebAuthnService] Registration verification failed for user: ${userId}`,
        );
        return { verified: false };
      }

      // Get the credential ID and public key
      // Extract the necessary properties from registrationInfo
      // Note: The TypeScript types from @simplewebauthn/server don't match the actual return value
      // This is a workaround until the types are fixed
      // The TypeScript types from @simplewebauthn/server don't match the actual return value
      // Create a properly typed interface for the registration info
      interface RegistrationInfoWithCredentials {
        credentialID: Uint8Array;
        credentialPublicKey: Uint8Array;
        counter: number;
      }

      const registrationInfoTyped =
        registrationInfo as unknown as RegistrationInfoWithCredentials;
      const credentialID = registrationInfoTyped.credentialID;
      const credentialPublicKey = registrationInfoTyped.credentialPublicKey;
      const counter = registrationInfoTyped.counter;

      // Convert the credential ID and public key to base64url strings
      const credentialIdBase64 =
        Buffer.from(credentialID).toString("base64url");
      const publicKeyBase64 =
        Buffer.from(credentialPublicKey).toString("base64url");

      // Store the credential in the database
      const newCredential = {
        id: createId(),
        userId,
        credentialId: credentialIdBase64,
        publicKey: publicKeyBase64,
        counter: counter.toString(),
        credentialDeviceType: response.authenticatorAttachment || "platform",
        credentialBackedUp: false, // Default to false if we can't determine
        transports: (response as ExtendedRegistrationResponseJSON).response
          .transports
          ? JSON.stringify(
              (response as ExtendedRegistrationResponseJSON).response
                .transports,
            )
          : null,
        friendlyName:
          friendlyName || `Credential ${new Date().toLocaleDateString()}`,
      };

      await db.insert(webauthnCredentials).values(newCredential);

      console.log(
        `[WebAuthnService] Registration successful for user: ${userId}`,
      );
      return { verified: true, credentialId: credentialIdBase64 };
    } catch (error) {
      console.error(
        `[WebAuthnService] Error during registration verification:`,
        error,
      );
      return { verified: false, error: (error as Error).message };
    }
  }

  /**
   * Generate options for authenticating with a WebAuthn credential
   * @param userId Optional user ID (if known)
   * @returns Authentication options
   */
  static async generateAuthenticationOptions(userId?: string) {
    console.log(
      `[WebAuthnService] Generating authentication options${userId ? ` for user: ${userId}` : ""}`,
    );

    // If userId is provided, get the user's credentials
    let allowCredentials;
    if (userId) {
      const userCredentials = await db
        .select({
          credentialId: webauthnCredentials.credentialId,
          transports: webauthnCredentials.transports,
        })
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.userId, userId));

      // Convert the credentials to the format expected by generateAuthenticationOptions
      allowCredentials = userCredentials.map((credential) => ({
        id: credential.credentialId,
        type: "public-key" as const,
        transports: credential.transports
          ? JSON.parse(credential.transports as string)
          : undefined,
      }));
    }

    // Generate authentication options
    const options = await generateAuthenticationOptions({
      rpID: authConfig.webauthn.rpID,
      // Allow any authenticator
      allowCredentials,
      userVerification: "preferred",
    });

    return options;
  }

  /**
   * Verify a WebAuthn authentication response
   * @param response The authentication response from the client
   * @param expectedChallenge The expected challenge string retrieved from the user's session.
   * @returns The verification result, including user information if successful.
   * @remarks
   * This method uses a type assertion (`as unknown as Parameters<typeof verifyAuthenticationResponse>[0]`)
   * when calling `verifyAuthenticationResponse` with the `verificationParams` object.
   * This is necessary because the structure defined in our local `VerifyAuthenticationResponseOpts`,
   * particularly the inclusion of the `authenticator` object, aligns with the runtime requirements
   * but may not match the library's potentially inaccurate compile-time type definitions.
   */
  static async verifyAuthentication(
    response: AuthenticationResponseJSON,
    expectedChallenge: string,
  ) {
    console.log(
      `[WebAuthnService] Verifying authentication for credential: ${response.id}`,
    );

    try {
      // Find the credential in the database
      const credentialResult = await db
        .select()
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.credentialId, response.id))
        .limit(1);

      if (credentialResult.length === 0) {
        console.warn(`[WebAuthnService] Credential not found: ${response.id}`);
        return { verified: false, error: "Credential not found" };
      }

      const credential = credentialResult[0];

      // Get the authenticator device
      const authenticator = {
        credentialID: credential.credentialId,
        credentialPublicKey: Buffer.from(credential.publicKey, "base64url"),
        counter: parseInt(credential.counter, 10),
        transports: credential.transports
          ? JSON.parse(credential.transports as string)
          : undefined,
      };

      // Verify the authentication response
      // The TypeScript types from @simplewebauthn/server don't match the actual expected input
      // We need to use a properly typed interface to make it work
      // The expectedChallenge parameter takes a callback function that compares the challenge
      // extracted from the clientDataJSON with our stored challenge from the session
      // This is a critical security check to prevent replay attacks
      // Use our custom type to properly type the verification parameters
      // This ensures type safety while allowing the authenticator property
      const verificationParams: VerifyAuthenticationResponseOpts = {
        response,
        expectedChallenge: (clientChallenge: string) => {
          console.log(
            `[WebAuthnService] Comparing client challenge with expected challenge`,
          );
          console.log(
            `[WebAuthnService] Client challenge: ${clientChallenge.substring(0, 10)}...`,
          );
          console.log(
            `[WebAuthnService] Expected challenge: ${expectedChallenge.substring(0, 10)}...`,
          );
          return clientChallenge === expectedChallenge;
        },
        expectedOrigin,
        expectedRPID: authConfig.webauthn.rpID,
        authenticator,
      };

      const verification = await verifyAuthenticationResponse(
        verificationParams as unknown as Parameters<
          typeof verifyAuthenticationResponse
        >[0],
      );

      const { verified, authenticationInfo } = verification;

      if (!verified) {
        console.warn(
          `[WebAuthnService] Authentication verification failed for credential: ${response.id}`,
        );
        return { verified: false };
      }

      // Update the credential counter in the database
      await db
        .update(webauthnCredentials)
        .set({ counter: authenticationInfo.newCounter.toString() })
        .where(eq(webauthnCredentials.credentialId, response.id));

      // Get the user information
      const userResult = await db
        .select()
        .from(users)
        .where(eq(users.id, credential.userId))
        .limit(1);

      if (userResult.length === 0) {
        console.warn(
          `[WebAuthnService] User not found for credential: ${response.id}`,
        );
        return { verified: true, error: "User not found" };
      }

      const user = userResult[0];

      console.log(
        `[WebAuthnService] Authentication successful for user: ${user.id}`,
      );
      return { verified: true, user };
    } catch (error) {
      console.error(
        `[WebAuthnService] Error during authentication verification:`,
        error,
      );
      return { verified: false, error: (error as Error).message };
    }
  }

  /**
   * Get all WebAuthn credentials registered for a specific user.
   * @param userId The ID of the user whose credentials are to be retrieved.
   * @returns A promise that resolves to an array of credential objects, containing selected fields safe for client display.
   */
  static async getUserCredentials(userId: string) {
    console.log(`[WebAuthnService] Getting credentials for user: ${userId}`);

    const credentials = await db
      .select({
        id: webauthnCredentials.id,
        credentialId: webauthnCredentials.credentialId,
        credentialDeviceType: webauthnCredentials.credentialDeviceType,
        credentialBackedUp: webauthnCredentials.credentialBackedUp,
        transports: webauthnCredentials.transports,
        friendlyName: webauthnCredentials.friendlyName,
        createdAt: webauthnCredentials.createdAt,
      })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, userId));

    return credentials;
  }

  /**
   * Delete a WebAuthn credential
   * @param credentialId The credential ID
   * @param userId The user ID (for verification)
   * @returns Whether the deletion was successful
   */
  static async deleteCredential(credentialId: string, userId: string) {
    console.log(
      `[WebAuthnService] Deleting credential: ${credentialId} for user: ${userId}`,
    );

    // Find the credential in the database
    const credentialResult = await db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.id, credentialId))
      .limit(1);

    if (credentialResult.length === 0) {
      console.warn(`[WebAuthnService] Credential not found: ${credentialId}`);
      return { success: false, error: "Credential not found" };
    }

    const credential = credentialResult[0];

    // Verify that the credential belongs to the user
    if (credential.userId !== userId) {
      console.warn(
        `[WebAuthnService] Credential does not belong to user: ${userId}`,
      );
      return { success: false, error: "Credential does not belong to user" };
    }

    // Delete the credential
    await db
      .delete(webauthnCredentials)
      .where(eq(webauthnCredentials.id, credentialId));

    console.log(`[WebAuthnService] Credential deleted: ${credentialId}`);
    return { success: true };
  }

  /**
   * Update a WebAuthn credential's friendly name
   * @param credentialId The credential ID
   * @param userId The user ID (for verification)
   * @param friendlyName The new friendly name
   * @returns Whether the update was successful
   */
  static async updateCredentialName(
    credentialId: string,
    userId: string,
    friendlyName: string,
  ) {
    console.log(
      `[WebAuthnService] Updating credential name: ${credentialId} for user: ${userId}`,
    );

    // Find the credential in the database
    const credentialResult = await db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.id, credentialId))
      .limit(1);

    if (credentialResult.length === 0) {
      console.warn(`[WebAuthnService] Credential not found: ${credentialId}`);
      return { success: false, error: "Credential not found" };
    }

    const credential = credentialResult[0];

    // Verify that the credential belongs to the user
    if (credential.userId !== userId) {
      console.warn(
        `[WebAuthnService] Credential does not belong to user: ${userId}`,
      );
      return { success: false, error: "Credential does not belong to user" };
    }

    // Update the credential
    await db
      .update(webauthnCredentials)
      .set({ friendlyName })
      .where(eq(webauthnCredentials.id, credentialId));

    console.log(`[WebAuthnService] Credential name updated: ${credentialId}`);
    return { success: true };
  }
}

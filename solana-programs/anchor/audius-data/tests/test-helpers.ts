import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import Web3 from "web3";
import { Account } from "web3-core";
import { randomBytes } from "crypto";
import { expect } from "chai";
import {
  findDerivedPair,
  getTransaction,
  randomCID,
  getTransactionWithData,
  getContentNode,
  randomId,
} from "../lib/utils";
import {
  createContentNode,
  createUser,
  createTrack,
  createPlaylist,
  initUser,
  initUserSolPubkey,
  deleteTrack,
  updateTrack,
  EntityTypesEnumValues,
  ManagementActions,
  deletePlaylist,
  updatePlaylist,
  updateAdmin,
} from "../lib/lib";
import { AudiusData } from "../target/types/audius_data";

const { PublicKey, SystemProgram } = anchor.web3;

export const EthWeb3 = new Web3();
const DefaultPubkey = new PublicKey("11111111111111111111111111111111");

type InitTestConsts = {
  ethAccount: Account;
  handle: string;
  handleBytes: Buffer;
  handleBytesArray: number[];
  metadata: string;
  userId: anchor.BN;
};

export const initTestConstants = (): InitTestConsts => {
  const ethAccount = EthWeb3.eth.accounts.create();
  const handle = randomBytes(40).toString("hex");
  const handleBytes = Buffer.from(anchor.utils.bytes.utf8.encode(handle));
  const handleBytesArray = Array.from({ ...handleBytes, length: 32 });
  const metadata = randomCID();
  const userId = randomId();

  return {
    ethAccount,
    handle,
    handleBytes,
    handleBytesArray,
    metadata,
    userId,
  };
};

export const testInitUser = async ({
  provider,
  program,
  baseAuthorityAccount,
  ethAddress,
  handleBytesArray,
  bumpSeed,
  metadata,
  userStorageAccount,
  adminStorageKeypair,
  adminKeypair,
  replicaSet,
  replicaSetBumps,
  cn1,
  cn2,
  cn3,
}) => {
  const tx = await initUser({
    provider,
    program,
    ethAddress,
    replicaSet,
    replicaSetBumps,
    handleBytesArray,
    bumpSeed,
    metadata,
    userStorageAccount,
    baseAuthorityAccount,
    adminStorageAccount: adminStorageKeypair.publicKey,
    adminKeypair,
    cn1,
    cn2,
    cn3,
  });

  const account = await program.account.user.fetch(userStorageAccount);

  const chainEthAddress = EthWeb3.utils.bytesToHex(account.ethAddress);
  expect(chainEthAddress, "eth address").to.equal(ethAddress.toLowerCase());
  const chainAuthority = account.authority.toString();
  const expectedAuthority = DefaultPubkey.toString();
  expect(chainAuthority, "authority").to.equal(expectedAuthority);

  const { decodedInstruction, decodedData } = await getTransactionWithData(
    program,
    provider,
    tx,
    0
  );

  expect(decodedInstruction.name).to.equal("initUser");
  expect(decodedData.metadata).to.equal(metadata);
};

export const testInitUserSolPubkey = async ({
  provider,
  program,
  message,
  ethPrivateKey,
  newUserPublicKey,
  newUserAcctPDA,
}) => {
  const tx = await initUserSolPubkey({
    provider,
    program,
    ethPrivateKey,
    message,
    userSolPubkey: newUserPublicKey,
    userStorageAccount: newUserAcctPDA,
  });

  const { decodedInstruction, decodedData } = await getTransactionWithData(
    program,
    provider,
    tx,
    1
  );

  expect(decodedInstruction.name).to.equal("initUserSol");
  expect(decodedData.userAuthority.toString()).to.equal(
    newUserPublicKey.toString()
  );

  const account = await program.account.user.fetch(newUserAcctPDA);

  const chainAuthority = account.authority.toString();
  const expectedAuthority = newUserPublicKey.toString();
  expect(chainAuthority, "authority").to.equal(expectedAuthority);
};

export const testCreateUser = async ({
  provider,
  program,
  message,
  baseAuthorityAccount,
  ethAccount,
  handleBytesArray,
  bumpSeed,
  metadata,
  newUserKeypair,
  userStorageAccount,
  adminStoragePublicKey,
  replicaSet,
  replicaSetBumps,
  cn1,
  cn2,
  cn3,
  userId,
}) => {
  const tx = await createUser({
    provider,
    program,
    ethAccount,
    message,
    handleBytesArray,
    bumpSeed,
    replicaSet,
    replicaSetBumps,
    metadata,
    userSolPubkey: newUserKeypair.publicKey,
    userStorageAccount,
    adminStoragePublicKey,
    baseAuthorityAccount,
    cn1,
    cn2,
    cn3,
    userId,
  });

  const { decodedInstruction, decodedData, accountPubKeys } =
    await getTransactionWithData(program, provider, tx, 1);

  expect(decodedInstruction.name).to.equal("createUser");
  expect(decodedData.base.toString()).to.equal(baseAuthorityAccount.toString());
  expect(decodedData.ethAddress).to.deep.equal([
    ...anchor.utils.bytes.hex.decode(ethAccount.address),
  ]);
  expect(decodedData.handleSeed).to.deep.equal(handleBytesArray);
  expect(decodedData.userBump).to.equal(bumpSeed);
  expect(decodedData.metadata).to.equal(metadata);
  expect(accountPubKeys[0]).to.equal(userStorageAccount.toString());
  expect(accountPubKeys[5]).to.equal(adminStoragePublicKey.toString());

  const account = await program.account.user.fetch(userStorageAccount);

  const chainEthAddress = EthWeb3.utils.bytesToHex(account.ethAddress);
  expect(chainEthAddress, "eth address").to.equal(
    ethAccount.address.toLowerCase()
  );

  const chainAuthority = account.authority.toString();
  const expectedAuthority = newUserKeypair.publicKey.toString();
  expect(chainAuthority, "authority").to.equal(expectedAuthority);
};

export const testCreateTrack = async ({
  provider,
  program,
  id,
  baseAuthorityAccount,
  handleBytesArray,
  bumpSeed,
  adminStorageAccount,
  trackMetadata,
  userAuthorityKeypair,
  trackOwnerPDA,
  userAuthorityDelegateAccountPDA,
  authorityDelegationStatusAccountPDA,
}) => {
  const tx = await createTrack({
    id,
    program,
    userAuthorityKeypair,
    userStorageAccountPDA: trackOwnerPDA,
    userAuthorityDelegateAccountPDA,
    authorityDelegationStatusAccountPDA,
    metadata: trackMetadata,
    baseAuthorityAccount,
    handleBytesArray,
    adminStorageAccount,
    bumpSeed,
  });
  const { decodedInstruction, decodedData, accountPubKeys } =
    await getTransactionWithData(program, provider, tx, 0);
  // Validate instruction data
  expect(decodedInstruction.name).to.equal("manageEntity");
  expect(decodedData.id.toString()).to.deep.equal(id.toString());
  expect(decodedData.metadata).to.equal(trackMetadata);
  expect(decodedData.entityType).to.deep.equal(EntityTypesEnumValues.track);
  expect(decodedData.managementAction).to.deep.equal(ManagementActions.create);
  // Assert on instruction struct
  // 1st index = track owner user storage account
  // 2nd index = user authority keypair
  // Indexing code must check that the track owner PDA is known before processing
  expect(accountPubKeys[1]).to.equal(trackOwnerPDA.toString());
  expect(accountPubKeys[2]).to.equal(userAuthorityKeypair.publicKey.toString());
};

export const testDeleteTrack = async ({
  provider,
  program,
  id,
  trackOwnerPDA,
  userAuthorityDelegateAccountPDA,
  authorityDelegationStatusAccountPDA,
  userAuthorityKeypair,
  baseAuthorityAccount,
  handleBytesArray,
  bumpSeed,
  adminStorageAccount,
}) => {
  const tx = await deleteTrack({
    id,
    provider,
    program,
    userStorageAccountPDA: trackOwnerPDA,
    userAuthorityDelegateAccountPDA,
    authorityDelegationStatusAccountPDA,
    userAuthorityKeypair: userAuthorityKeypair,
    baseAuthorityAccount,
    handleBytesArray,
    bumpSeed,
    adminStorageAccount,
  });
  const { decodedInstruction, decodedData, accountPubKeys } =
    await getTransactionWithData(program, provider, tx, 0);
  expect(decodedInstruction.name).to.equal("manageEntity");
  expect(decodedData.id.toString()).to.equal(id.toString());
  expect(decodedData.entityType).to.deep.equal(EntityTypesEnumValues.track);
  expect(decodedData.managementAction).to.deep.equal(ManagementActions.delete);
  // Assert on instruction struct
  // 0th index = track owner user storage account
  // 1st index = user authority keypair
  // Indexing code must check that the track owner PDA is known before processing
  expect(accountPubKeys[1]).to.equal(trackOwnerPDA.toString());
  expect(accountPubKeys[2]).to.equal(userAuthorityKeypair.publicKey.toString());
};

export const testUpdateTrack = async ({
  provider,
  program,
  id,
  userStorageAccountPDA,
  userAuthorityDelegateAccountPDA,
  authorityDelegationStatusAccountPDA,
  metadata,
  userAuthorityKeypair,
  baseAuthorityAccount,
  handleBytesArray,
  bumpSeed,
  adminStorageAccount,
}) => {
  const tx = await updateTrack({
    program,
    baseAuthorityAccount,
    handleBytesArray,
    bumpSeed,
    adminStorageAccount,
    id,
    userStorageAccountPDA,
    userAuthorityDelegateAccountPDA,
    authorityDelegationStatusAccountPDA,
    metadata,
    userAuthorityKeypair,
  });
  const { decodedInstruction, decodedData, accountPubKeys } =
    await getTransactionWithData(program, provider, tx, 0);

  // Validate instruction data
  expect(decodedInstruction.name).to.equal("manageEntity");
  expect(decodedData.id.toString()).to.equal(id.toString());
  expect(decodedData.metadata).to.equal(metadata);
  expect(decodedData.entityType).to.deep.equal(EntityTypesEnumValues.track);
  expect(decodedData.managementAction).to.deep.equal(ManagementActions.update);
  // Assert on instruction struct
  // 0th index = track owner user storage account
  // 1st index = user authority keypair
  // Indexing code must check that the track owner PDA is known before processing
  expect(accountPubKeys[1]).to.equal(userStorageAccountPDA.toString());
  expect(accountPubKeys[2]).to.equal(userAuthorityKeypair.publicKey.toString());
};

export const testCreatePlaylist = async ({
  provider,
  program,
  id,
  baseAuthorityAccount,
  handleBytesArray,
  bumpSeed,
  adminStorageAccount,
  playlistMetadata,
  userAuthorityKeypair,
  playlistOwnerPDA,
  userAuthorityDelegateAccountPDA,
  authorityDelegationStatusAccountPDA,
}) => {
  const tx = await createPlaylist({
    id,
    program,
    userAuthorityKeypair,
    userStorageAccountPDA: playlistOwnerPDA,
    userAuthorityDelegateAccountPDA,
    authorityDelegationStatusAccountPDA,
    metadata: playlistMetadata,
    baseAuthorityAccount,
    handleBytesArray,
    adminStorageAccount,
    bumpSeed,
  });
  const { decodedInstruction, decodedData, accountPubKeys } =
    await getTransactionWithData(program, provider, tx, 0);
  // Validate instruction data
  expect(decodedInstruction.name).to.equal("manageEntity");
  expect(decodedData.id.toString()).to.equal(id.toString());
  expect(decodedData.metadata).to.equal(playlistMetadata);
  expect(decodedData.entityType).to.deep.equal(EntityTypesEnumValues.playlist);
  expect(decodedData.managementAction).to.deep.equal(ManagementActions.create);
  // Assert on instruction struct
  // 1st index = playlist owner user storage account
  // 2nd index = user authority keypair
  // Indexing code must check that the playlist owner PDA is known before processing
  expect(accountPubKeys[1]).to.equal(playlistOwnerPDA.toString());
  expect(accountPubKeys[2]).to.equal(userAuthorityKeypair.publicKey.toString());
};

export const testDeletePlaylist = async ({
  provider,
  program,
  id,
  playlistOwnerPDA,
  userAuthorityDelegateAccountPDA,
  authorityDelegationStatusAccountPDA,
  userAuthorityKeypair,
  baseAuthorityAccount,
  handleBytesArray,
  bumpSeed,
  adminStorageAccount,
}) => {
  const tx = await deletePlaylist({
    id,
    provider,
    program,
    userStorageAccountPDA: playlistOwnerPDA,
    userAuthorityDelegateAccountPDA,
    authorityDelegationStatusAccountPDA,
    userAuthorityKeypair: userAuthorityKeypair,
    baseAuthorityAccount,
    handleBytesArray,
    bumpSeed,
    adminStorageAccount,
  });
  const { decodedInstruction, decodedData, accountPubKeys } =
    await getTransactionWithData(program, provider, tx, 0);
  expect(decodedInstruction.name).to.equal("manageEntity");
  expect(decodedData.id.toString()).to.equal(id.toString());
  expect(decodedData.entityType).to.deep.equal(EntityTypesEnumValues.playlist);
  expect(decodedData.managementAction).to.deep.equal(ManagementActions.delete);
  // Assert on instruction struct
  // 0th index = playlist owner user storage account
  // 1st index = user authority keypair
  // Indexing code must check that the playlist owner PDA is known before processing
  expect(accountPubKeys[1]).to.equal(playlistOwnerPDA.toString());
  expect(accountPubKeys[2]).to.equal(userAuthorityKeypair.publicKey.toString());
};

export const testUpdatePlaylist = async ({
  provider,
  program,
  id,
  userStorageAccountPDA,
  userAuthorityDelegateAccountPDA,
  authorityDelegationStatusAccountPDA,
  metadata,
  userAuthorityKeypair,
  baseAuthorityAccount,
  handleBytesArray,
  bumpSeed,
  adminStorageAccount,
}) => {
  const tx = await updatePlaylist({
    program,
    baseAuthorityAccount,
    handleBytesArray,
    bumpSeed,
    adminStorageAccount,
    id,
    userStorageAccountPDA,
    userAuthorityDelegateAccountPDA,
    authorityDelegationStatusAccountPDA,
    metadata,
    userAuthorityKeypair,
  });
  const { decodedInstruction, decodedData, accountPubKeys } =
    await getTransactionWithData(program, provider, tx, 0);

  // Validate instruction data
  expect(decodedInstruction.name).to.equal("manageEntity");
  expect(decodedData.id.toString()).to.equal(id.toString());
  expect(decodedData.metadata).to.equal(metadata);
  expect(decodedData.entityType).to.deep.equal(EntityTypesEnumValues.playlist);
  expect(decodedData.managementAction).to.deep.equal(ManagementActions.update);
  // Assert on instruction struct
  // 0th index = playlist owner user storage account
  // 1st index = user authority keypair
  // Indexing code must check that the playlist owner PDA is known before processing
  expect(accountPubKeys[1]).to.equal(userStorageAccountPDA.toString());
  expect(accountPubKeys[2]).to.equal(userAuthorityKeypair.publicKey.toString());
};

export const testCreateUserDelegate = async ({
  adminKeypair,
  adminStorageKeypair,
  program,
  provider,
}) => {
  // disable admin writes
  await updateAdmin({
    program,
    isWriteEnabled: false,
    adminStorageAccount: adminStorageKeypair.publicKey,
    adminAuthorityKeypair: adminKeypair,
  });

  const user = await createSolanaUser(program, provider, adminStorageKeypair);

  // Init AuthorityDelegationStatus for a new authority
  const userAuthorityDelegateKeypair = anchor.web3.Keypair.generate();
  const authorityDelegationStatusSeeds = [
    Buffer.from("authority-delegation-status", "utf8"),
    userAuthorityDelegateKeypair.publicKey.toBytes().slice(0, 32),
  ];

  const authorityDelegationStatusRes = await PublicKey.findProgramAddress(
    authorityDelegationStatusSeeds,
    program.programId
  );
  const authorityDelegationStatusPDA = authorityDelegationStatusRes[0];
  const authorityDelegationStatusBump = authorityDelegationStatusRes[1];

  const initAuthorityDelegationStatusArgs = {
    accounts: {
      delegateAuthority: userAuthorityDelegateKeypair.publicKey,
      authorityDelegationStatusPda: authorityDelegationStatusPDA,
      payer: provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    },
    signers: [userAuthorityDelegateKeypair],
  };

  const initAuthorityDelegationStatusTx =
    await program.rpc.initAuthorityDelegationStatus(
      "authority_name",
      initAuthorityDelegationStatusArgs
    );

  const {
    decodedInstruction: authorityDelegationInstruction,
    decodedData: authorityDelegationInstructionData,
  } = await getTransactionWithData(
    program,
    provider,
    initAuthorityDelegationStatusTx,
    0
  );
  expect(authorityDelegationInstruction.name).to.equal(
    "initAuthorityDelegationStatus"
  );
  expect(authorityDelegationInstructionData.authorityName).to.equal(
    "authority_name"
  );

  // New sol key that will be used as user authority delegate
  const userAuthorityDelegateSeeds = [
    user.pda.toBytes().slice(0, 32),
    userAuthorityDelegateKeypair.publicKey.toBytes().slice(0, 32),
  ];
  const res = await PublicKey.findProgramAddress(
    userAuthorityDelegateSeeds,
    program.programId
  );
  const userAuthorityDelegatePDA = res[0];
  const userAuthorityDelegateBump = res[1];

  const addUserAuthorityDelegateArgs = {
    accounts: {
      admin: adminStorageKeypair.publicKey,
      user: user.pda,
      currentUserAuthorityDelegate: userAuthorityDelegatePDA,
      signerUserAuthorityDelegate: SystemProgram.programId,
      authorityDelegationStatus: SystemProgram.programId,
      authority: user.keypair.publicKey,
      payer: provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    },
    signers: [user.keypair],
  };

  const addUserAuthorityDelegateTx = await program.rpc.addUserAuthorityDelegate(
    user.authority,
    user.handleBytesArray,
    user.bumpSeed,
    userAuthorityDelegateKeypair.publicKey,
    addUserAuthorityDelegateArgs
  );

  const {
    decodedInstruction: addUserAuthorityDelegateInstruction,
    decodedData: addUserAuthorityDelegateData,
  } = await getTransactionWithData(
    program,
    provider,
    addUserAuthorityDelegateTx,
    0
  );
  expect(addUserAuthorityDelegateInstruction.name).to.equal(
    "addUserAuthorityDelegate"
  );

  expect(addUserAuthorityDelegateData.base.toString()).to.equal(
    user.authority.toString()
  );
  expect(addUserAuthorityDelegateData.handleSeed.toString()).to.equal(
    user.handleBytesArray.toString()
  );
  expect(addUserAuthorityDelegateData.userBump).to.equal(user.bumpSeed);
  expect(
    addUserAuthorityDelegateData.userAuthorityDelegate.toString()
  ).to.equal(userAuthorityDelegateKeypair.publicKey.toString());

  return {
    baseAuthorityAccount: user.authority,
    userHandleBytesArray: user.handleBytesArray,
    userBumpSeed: user.bumpSeed,
    userAccountPDA: user.pda,
    userAuthorityDelegatePDA,
    userAuthorityDelegateBump,
    authorityDelegationStatusPDA,
    authorityDelegationStatusBump,
    userKeypair: user.keypair,
    userAuthorityDelegateKeypair,
  };
};

export const pollAccountBalance = async (args: {
  provider: anchor.Provider;
  targetAccount: anchor.web3.PublicKey;
  targetBalance: number;
  maxRetries: number;
}) => {
  let currentBalance = await args.provider.connection.getBalance(
    args.targetAccount
  );
  let numRetries = 0;
  while (currentBalance > args.targetBalance && numRetries < args.maxRetries) {
    currentBalance = await args.provider.connection.getBalance(
      args.targetAccount
    );
    numRetries--;
  }
  if (currentBalance > args.targetBalance) {
    throw new Error(
      `Account ${args.targetAccount} failed to reach target balance ${args.targetBalance} in ${args.maxRetries} retries. Current balance = ${currentBalance}`
    );
  }
};

export const confirmLogInTransaction = async (
  provider: anchor.Provider,
  tx: string,
  log: string
) => {
  const info = await getTransaction(provider, tx);

  const logs = info.meta.logMessages;
  let stringFound = false;
  logs.forEach((v) => {
    if (v.indexOf(log) !== -1) {
      stringFound = true;
    }
  });
  if (!stringFound) {
    console.log(logs);
    throw new Error(`Failed to find ${log} in tx=${tx}`);
  }
  return info;
};

export const createSolanaUser = async (
  program: Program<AudiusData>,
  provider: anchor.Provider,
  adminStorageKeypair: anchor.web3.Keypair
) => {
  const testConsts = initTestConstants();

  const {
    baseAuthorityAccount,
    bumpSeed,
    derivedAddress: newUserAcctPDA,
  } = await findDerivedPair(
    program.programId,
    adminStorageKeypair.publicKey,
    Buffer.from(testConsts.handleBytesArray)
  );

  // New sol key that will be used to permission user updates
  const newUserKeypair = anchor.web3.Keypair.generate();

  // Generate signed SECP instruction
  // Message as the incoming public key
  const message = newUserKeypair.publicKey.toBytes();

  const cn1 = await getContentNode(program, adminStorageKeypair.publicKey, "1");
  const cn2 = await getContentNode(program, adminStorageKeypair.publicKey, "2");
  const cn3 = await getContentNode(program, adminStorageKeypair.publicKey, "3");

  await createUser({
    provider,
    program,
    ethAccount: testConsts.ethAccount,
    handleBytesArray: testConsts.handleBytesArray,
    message,
    bumpSeed,
    metadata: testConsts.metadata,
    userSolPubkey: newUserKeypair.publicKey,
    userStorageAccount: newUserAcctPDA,
    adminStoragePublicKey: adminStorageKeypair.publicKey,
    baseAuthorityAccount,
    replicaSet: [1, 2, 3],
    replicaSetBumps: [cn1.bumpSeed, cn2.bumpSeed, cn3.bumpSeed],
    cn1: cn1.derivedAddress,
    cn2: cn2.derivedAddress,
    cn3: cn3.derivedAddress,
    userId: testConsts.userId,
  });

  const account = await program.account.user.fetch(newUserAcctPDA);

  return {
    account,
    pda: newUserAcctPDA,
    handleBytesArray: testConsts.handleBytesArray,
    bumpSeed,
    keypair: newUserKeypair,
    authority: baseAuthorityAccount,
  };
};

export const createSolanaContentNode = async (props: {
  program: Program<AudiusData>;
  provider: anchor.Provider;
  adminStorageKeypair: anchor.web3.Keypair;
  adminKeypair: anchor.web3.Keypair;
  spId: anchor.BN;
}) => {
  const ownerEth = EthWeb3.eth.accounts.create();
  const authority = anchor.web3.Keypair.generate();
  const seed = Buffer.concat([
    Buffer.from("sp_id", "utf8"),
    props.spId.toBuffer("le", 2),
  ]);

  const { baseAuthorityAccount, bumpSeed, derivedAddress } =
    await findDerivedPair(
      props.program.programId,
      props.adminStorageKeypair.publicKey,
      seed
    );

  const tx = await createContentNode({
    provider: props.provider,
    program: props.program,
    adminKeypair: props.adminKeypair,
    baseAuthorityAccount,
    adminStoragePublicKey: props.adminStorageKeypair.publicKey,
    contentNodeAuthority: authority.publicKey,
    contentNodeAcct: derivedAddress,
    spID: props.spId,
    ownerEthAddress: ownerEth.address,
  });

  const contentNode = await props.program.account.contentNode.fetch(
    derivedAddress
  );

  if (!contentNode) {
    throw new Error("unable to create playlist account");
  }

  return {
    ownerEthAddress: ownerEth.address,
    spId: props.spId,
    account: contentNode,
    pda: derivedAddress,
    authority,
    seedBump: { seed, bump: bumpSeed },
    tx,
  };
};

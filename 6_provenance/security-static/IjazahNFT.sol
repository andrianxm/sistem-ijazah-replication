// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
//  IMPORT OpenZeppelin v5
// ============================================================
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title   IjazahNFT v3.0 (Hybrid Privacy)
 * @author  Universitas Web3 — Backend Laravel (Senior Web3 Dev)
 * @notice  Custodial NFT untuk otentikasi Ijazah Digital.
 *          Menyeimbangkan transparansi (NINA & CID Plaintext) dengan
 *          Privasi (NIM Hashed, Sisa data Encrypted).
 *
 * @custom:network  Polygon Amoy (testnet, chainId 80002)
 * @custom:version  3.0.0
 */
contract IjazahNFT is ERC721, AccessControl, ReentrancyGuard, Pausable {

    // ============================================================
    //  ROLES
    // ============================================================
    bytes32 public constant REKTOR_ROLE = keccak256("REKTOR_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    // ============================================================
    //  STRUCT & STORAGE
    // ============================================================
    struct DokumenIjazah {
        bytes32 hashedNina;
        bytes32 hashedNim;
        string  cid;
        string  encData;
        uint256 mintedAt;
        uint256 updatedAt;
        bool    isActive;
        address mintedBy;
        string  revokeReason;
        uint256 institutionId;
    }

    struct UpdateLog {
        string  oldEncData;
        string  newEncData;
        address updatedBy;
        uint256 timestamp;
    }

    struct Institution {
        string  name;
        address admin;
        bool    isActive;
    }

    mapping(uint256 => DokumenIjazah) private _dokumen;
    mapping(bytes32 => uint256) private _hashedNinaToTokenId;
    mapping(bytes32 => uint256) private _hashedNimToTokenId;
    mapping(uint256 => UpdateLog[]) private _updateHistory;
    mapping(uint256 => Institution) private _institutions;

    uint256 private _nextTokenId = 1001;
    uint256 private _nextInstitutionId = 1;

    // ============================================================
    //  EVENTS
    // ============================================================
    event IjazahDimint(
        uint256 indexed tokenId,
        bytes32 hashedNina,
        bytes32 hashedNim,
        address indexed mintedBy,
        uint256 institutionId,
        uint256 timestamp
    );

    event IjazahDiupdate(
        uint256 indexed tokenId,
        address indexed updatedBy,
        uint256 updateCount,
        uint256 timestamp
    );

    event IjazahDirevoke(
        uint256 indexed tokenId,
        address indexed revokedBy,
        string  reason,
        uint256 timestamp
    );

    event RektorDiganti(
        address indexed rektorLama,
        address indexed rektorBaru,
        uint256 timestamp
    );

    event InstitutionRegistered(
        uint256 indexed institutionId,
        string  name,
        address indexed admin,
        uint256 timestamp
    );

    event BatchMintCompleted(
        uint256 indexed startTokenId,
        uint256 indexed endTokenId,
        uint256 count,
        address indexed mintedBy,
        uint256 timestamp
    );

    // ============================================================
    //  CONSTRUCTOR
    // ============================================================
    constructor(address _initialRektor)
        ERC721("Ijazah Digital NFT", "IJZ")
    {
        require(_initialRektor != address(0), "Alamat rektor tidak valid");
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(REKTOR_ROLE, _initialRektor);
        _grantRole(OPERATOR_ROLE, _initialRektor);
    }

    modifier tokenAktif(uint256 _tokenId) {
        require(_ownerOf(_tokenId) != address(0), "Token tidak exist");
        require(_dokumen[_tokenId].isActive, "Ijazah sudah direvoke");
        _;
    }

    // ============================================================
    //  FUNGSI WRITE — hanya REKTOR_ROLE
    // ============================================================
    function mintIjazah(
        bytes32 _hashedNina,
        bytes32 _hashedNim,
        string memory _cid,
        string memory _encData
    )
        external
        onlyRole(REKTOR_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        return _mintSingle(_hashedNina, _hashedNim, _cid, _encData, 0);
    }

    function mintIjazahForInstitution(
        bytes32 _hashedNina,
        bytes32 _hashedNim,
        string memory _cid,
        string memory _encData,
        uint256 _institutionId
    )
        external
        onlyRole(REKTOR_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        if (_institutionId > 0) {
            require(_institutions[_institutionId].isActive, "Institusi tidak aktif");
        }
        return _mintSingle(_hashedNina, _hashedNim, _cid, _encData, _institutionId);
    }

    function batchMintIjazah(
        bytes32[] memory _hashedNinaList,
        bytes32[] memory _hashedNimList,
        string[] memory _cidList,
        string[] memory _encDataList
    )
        external
        onlyRole(REKTOR_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256[] memory)
    {
        uint256 count = _hashedNinaList.length;
        require(count > 0, "Array tidak boleh kosong");
        require(count == _hashedNimList.length && count == _cidList.length && count == _encDataList.length, "Panjang array tidak sama");
        require(count <= 50, "Maksimal 50 ijazah per batch");

        uint256[] memory tokenIds = new uint256[](count);
        uint256 startId = _nextTokenId;

        for (uint256 i = 0; i < count; i++) {
            tokenIds[i] = _mintSingle(_hashedNinaList[i], _hashedNimList[i], _cidList[i], _encDataList[i], 0);
        }

        emit BatchMintCompleted(startId, _nextTokenId - 1, count, msg.sender, block.timestamp);
        return tokenIds;
    }

    function _mintSingle(
        bytes32 _hashedNina,
        bytes32 _hashedNim,
        string memory _cid,
        string memory _encData,
        uint256 _institutionId
    )
        internal
        returns (uint256)
    {
        require(_hashedNina != bytes32(0), "Hashed NINA tidak boleh kosong");
        require(_hashedNim != bytes32(0), "Hashed NIM tidak boleh kosong");
        require(bytes(_cid).length > 0, "CID tidak boleh kosong");

        uint256 existingId = _hashedNinaToTokenId[_hashedNina];
        if (existingId != 0) {
            require(!_dokumen[existingId].isActive, "NINA ini sudah memiliki ijazah aktif");
        }

        uint256 tokenId = _nextTokenId++;

        _dokumen[tokenId] = DokumenIjazah({
            hashedNina: _hashedNina,
            hashedNim: _hashedNim,
            cid: _cid,
            encData: _encData,
            mintedAt: block.timestamp,
            updatedAt: block.timestamp,
            isActive: true,
            mintedBy: msg.sender,
            revokeReason: "",
            institutionId: _institutionId
        });

        _hashedNinaToTokenId[_hashedNina] = tokenId;
        _hashedNimToTokenId[_hashedNim] = tokenId;

        _mint(address(this), tokenId);
        emit IjazahDimint(tokenId, _hashedNina, _hashedNim, msg.sender, _institutionId, block.timestamp);
        return tokenId;
    }

    function updateIjazah(
        uint256 _tokenId,
        string memory _newEncData
    )
        external
        onlyRole(REKTOR_ROLE)
        nonReentrant
        whenNotPaused
        tokenAktif(_tokenId)
    {
        _updateHistory[_tokenId].push(UpdateLog({
            oldEncData: _dokumen[_tokenId].encData,
            newEncData: _newEncData,
            updatedBy: msg.sender,
            timestamp: block.timestamp
        }));

        _dokumen[_tokenId].encData = _newEncData;
        _dokumen[_tokenId].updatedAt = block.timestamp;

        emit IjazahDiupdate(_tokenId, msg.sender, _updateHistory[_tokenId].length, block.timestamp);
    }

    function revokeIjazah(
        uint256 _tokenId,
        string memory _reason
    )
        external
        onlyRole(REKTOR_ROLE)
        nonReentrant
        whenNotPaused
        tokenAktif(_tokenId)
    {
        require(bytes(_reason).length > 0, "Alasan revoke wajib diisi");

        _dokumen[_tokenId].isActive = false;
        _dokumen[_tokenId].updatedAt = block.timestamp;
        _dokumen[_tokenId].revokeReason = _reason;

        emit IjazahDirevoke(_tokenId, msg.sender, _reason, block.timestamp);
    }

    // ============================================================
    //  MANAJEMEN PERGANTIAN REKTOR
    // ============================================================
    function gantiRektor(address _rektorLama, address _rektorBaru)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(_rektorBaru != address(0), "Alamat rektor baru tidak valid");
        require(_rektorLama != _rektorBaru, "Alamat sama");
        require(hasRole(REKTOR_ROLE, _rektorLama), "Alamat lama bukan pemegang REKTOR_ROLE");

        _revokeRole(REKTOR_ROLE, _rektorLama);
        _grantRole(REKTOR_ROLE, _rektorBaru);

        emit RektorDiganti(_rektorLama, _rektorBaru, block.timestamp);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    // ============================================================
    //  MULTI-INSTITUSI
    // ============================================================
    function registerInstitution(string memory _name, address _admin)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        returns (uint256)
    {
        require(bytes(_name).length > 0, "Nama institusi tidak boleh kosong");
        require(_admin != address(0), "Alamat admin tidak valid");

        uint256 institutionId = _nextInstitutionId++;
        _institutions[institutionId] = Institution({ name: _name, admin: _admin, isActive: true });
        _grantRole(OPERATOR_ROLE, _admin);

        emit InstitutionRegistered(institutionId, _name, _admin, block.timestamp);
        return institutionId;
    }

    function deactivateInstitution(uint256 _institutionId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_institutions[_institutionId].isActive, "Institusi sudah nonaktif");
        _institutions[_institutionId].isActive = false;
    }

    function getInstitution(uint256 _institutionId) external view returns (string memory name, address admin, bool isActive) {
        Institution storage inst = _institutions[_institutionId];
        return (inst.name, inst.admin, inst.isActive);
    }

    // ============================================================
    //  FUNGSI READ
    // ============================================================
    function getIjazahData(uint256 _tokenId)
        external
        view
        returns (
            bytes32        hashedNina,
            bytes32        hashedNim,
            string  memory cid,
            string  memory encData,
            uint256        mintedAt,
            uint256        updatedAt,
            bool           isActive,
            address        mintedBy
        )
    {
        require(_ownerOf(_tokenId) != address(0), "Token tidak exist");

        DokumenIjazah storage dok = _dokumen[_tokenId];
        return (
            dok.hashedNina,
            dok.hashedNim,
            dok.cid,
            dok.encData,
            dok.mintedAt,
            dok.updatedAt,
            dok.isActive,
            dok.mintedBy
        );
    }

    function getRevokeReason(uint256 _tokenId) external view returns (string memory reason) {
        require(_ownerOf(_tokenId) != address(0), "Token tidak exist");
        return _dokumen[_tokenId].revokeReason;
    }

    function getInstitutionId(uint256 _tokenId) external view returns (uint256) {
        require(_ownerOf(_tokenId) != address(0), "Token tidak exist");
        return _dokumen[_tokenId].institutionId;
    }

    function getUpdateHistory(uint256 _tokenId) external view returns (UpdateLog[] memory) {
        require(_ownerOf(_tokenId) != address(0), "Token tidak exist");
        return _updateHistory[_tokenId];
    }

    function getUpdateCount(uint256 _tokenId) external view returns (uint256) {
        return _updateHistory[_tokenId].length;
    }

    function getTokenIdByHashedNina(bytes32 _hashedNina) external view returns (uint256) {
        return _hashedNinaToTokenId[_hashedNina];
    }

    function getTokenIdByHashedNim(bytes32 _hashedNim) external view returns (uint256) {
        return _hashedNimToTokenId[_hashedNim];
    }
    
    // Fungsi ini disiapkan khusus untuk Verifikasi SIVIL yang memanggil via RPC
    // Mengembalikan: tokenId, cid, owner, exists
    function getIjazahByHashedNina(bytes32 _hashedNina) external view returns (
        uint256 tokenId,
        string memory cid,
        address owner,
        bool exists
    ) {
        tokenId = _hashedNinaToTokenId[_hashedNina];
        if (tokenId == 0) {
            return (0, "", address(0), false);
        }
        
        DokumenIjazah storage dok = _dokumen[tokenId];
        if (!dok.isActive) {
            return (0, "", address(0), false);
        }
        
        return (tokenId, dok.cid, _ownerOf(tokenId), true);
    }

    function countTotalMintedByContract() external view returns (uint256) {
        return balanceOf(address(this));
    }

    function getNextTokenId() external view returns (uint256) {
        return _nextTokenId;
    }

    // ============================================================
    //  OVERRIDE WAJIB
    // ============================================================
    function tokenURI(uint256 _tokenId) public view override returns (string memory) {
        require(_ownerOf(_tokenId) != address(0), "Token tidak exist");
        string memory cid = _dokumen[_tokenId].cid;
        return string(abi.encodePacked("ipfs://", cid));
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        require(from == address(0), "Transfer diblokir: ijazah tidak dapat dipindahtangankan");
        return super._update(to, tokenId, auth);
    }

    receive() external payable { revert("Contract ini tidak menerima MATIC"); }
    fallback() external payable { revert("Fungsi tidak ditemukan"); }
}
